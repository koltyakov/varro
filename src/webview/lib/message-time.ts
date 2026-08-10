export function formatMessageSentTime(created: number, now = new Date()) {
  const sent = new Date(created);
  const isToday =
    sent.getFullYear() === now.getFullYear() &&
    sent.getMonth() === now.getMonth() &&
    sent.getDate() === now.getDate();

  return new Intl.DateTimeFormat(
    undefined,
    isToday ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' }
  ).format(sent);
}
