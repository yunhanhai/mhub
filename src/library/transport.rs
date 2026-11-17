//! HTTP/1 transport for the exclusive library site. Keeping the response's
//! connection cancellation outside body polling also handles TCP backpressure.
use axum::{Extension, Router};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
    time::{Instant, Sleep},
};
use tokio_util::sync::CancellationToken;

const CONNECTION_LIMIT: usize = 128;
const WRITE_IDLE: Duration = Duration::from_secs(15);
const CONNECTION_IDLE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(super) struct ConnectionControl {
    pub(super) abort: CancellationToken,
}

/// Serve the exclusive library on HTTP/1 behind a TLS edge or on loopback.
/// Combined-site protocols and the independent gateway retain their own server.
pub async fn serve_bounded(
    listener: TcpListener,
    app: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    let slots = Arc::new(Semaphore::new(CONNECTION_LIMIT));
    let stop = CancellationToken::new();
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break Ok(()),
            _ = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (socket, _) = match accepted { Ok(value) => value, Err(error) => break Err(error) };
                let Ok(permit) = slots.clone().try_acquire_owned() else { drop(socket); continue };
                let control = ConnectionControl { abort: CancellationToken::new() };
                let service = TowerToHyperService::new(app.clone().layer(Extension(control.clone())));
                let stopped = stop.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let mut builder = http1::Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).max_buf_size(32768);
                    let connection = builder.serve_connection(TokioIo::new(TimedSocket::new(socket)), service);
                    tokio::pin!(connection);
                    tokio::select! {
                        biased;
                        _ = control.abort.cancelled() => {},
                        _ = stopped.cancelled() => {
                            connection.as_mut().graceful_shutdown();
                            let _ = tokio::time::timeout(Duration::from_secs(5), &mut connection).await;
                        },
                        _ = &mut connection => {},
                    }
                });
            }
        }
    };
    stop.cancel();
    if tokio::time::timeout(Duration::from_secs(6), async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
    result
}

struct TimedSocket {
    socket: TcpStream,
    idle: Pin<Box<Sleep>>,
    write_stall: Option<Pin<Box<Sleep>>>,
}
impl TimedSocket {
    fn new(socket: TcpStream) -> Self {
        Self {
            socket,
            idle: Box::pin(tokio::time::sleep(CONNECTION_IDLE)),
            write_stall: None,
        }
    }
    fn activity(&mut self) {
        self.idle.as_mut().reset(Instant::now() + CONNECTION_IDLE);
    }
    fn observe_write(
        &mut self,
        cx: &mut Context<'_>,
        result: Poll<io::Result<usize>>,
    ) -> Poll<io::Result<usize>> {
        match result {
            Poll::Ready(Ok(count)) => {
                if count > 0 {
                    self.activity();
                    self.write_stall = None;
                }
                Poll::Ready(Ok(count))
            }
            Poll::Pending => {
                let deadline = self
                    .write_stall
                    .get_or_insert_with(|| Box::pin(tokio::time::sleep(WRITE_IDLE)));
                if deadline.as_mut().poll(cx).is_ready() {
                    Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "library write stalled",
                    )))
                } else {
                    Poll::Pending
                }
            }
            result => result,
        }
    }
}
impl AsyncRead for TimedSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity();
        }
        if result.is_pending() && self.idle.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "library connection idle",
            )));
        }
        result
    }
}
impl AsyncWrite for TimedSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.socket).poll_write(cx, buf);
        self.observe_write(cx, result)
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.socket).poll_write_vectored(cx, bufs);
        self.observe_write(cx, result)
    }
    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}
