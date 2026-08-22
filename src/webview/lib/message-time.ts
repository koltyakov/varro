export function formatClockTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(timestamp);
}

export function formatMessageSentTime(created: number, now = new Date()) {
  const sent = new Date(created);
  const isToday =
    sent.getFullYear() === now.getFullYear() &&
    sent.getMonth() === now.getMonth() &&
    sent.getDate() === now.getDate();

  return isToday
    ? formatClockTime(created)
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(sent);
}
