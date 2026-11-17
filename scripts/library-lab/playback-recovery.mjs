// Recovery is selected from the library protocol, never from translated error text.
const accountCodes = new Set(['login_required', 'task_owner', 'track_permission']);
const catalogueCodes = new Set(['track_missing', 'version_changed', 'source_changed', 'policy_changed']);
const taskMessages = {
  login_required: '请先登录', task_owner: '此播放任务属于另一个会话',
  track_permission: '当前账号无法访问这首曲目', instance_missing: '曲库实例不存在',
  track_missing: '曲目不存在', version_changed: '曲目版本已变化，请重新选择',
  source_changed: '原文件与当前清单不一致', policy_changed: '曲目权限已变化',
  integrity_failed: '原文件校验失败',
};
export function playbackRecovery(error) {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : '';
  const http = error?.kind === 'http', task = error?.kind === 'task';
  const account = accountCodes.has(code) && (task || http && (error.status === 401 || error.status === 403))
    || code === 'instance_missing' && (task || http && error.status === 404);
  const catalogue = catalogueCodes.has(code) && (task || http && (error.status === 404 || error.status === 409));
  return { recovery: account ? 'identity' : catalogue ? 'catalogue' : 'retry', code,
    status: http && Number.isInteger(error.status) ? error.status : null };
}
export function failedPlaybackTask(code) {
  const safe = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : '';
  return Object.assign(new Error(taskMessages[safe] || '音频准备失败'), { kind: 'task', code: safe });
}
