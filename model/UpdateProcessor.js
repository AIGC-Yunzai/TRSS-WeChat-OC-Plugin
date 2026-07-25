export async function processUpdateBatch(result, handlers) {
  const {
    commitSyncBuf,
    handleMessage,
    isStopped = () => false,
  } = handlers

  for (const message of Array.isArray(result?.msgs) ? result.msgs : []) {
    if (isStopped()) return { committed: false }
    await handleMessage(message)
  }

  if (isStopped()) return { committed: false }
  if (result?.get_updates_buf) {
    await commitSyncBuf(result.get_updates_buf)
    return { committed: true }
  }
  return { committed: false }
}
