export function formatClockTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(timestamp);
}

export function formatMessageSentTime(created: number, now = new Date()) {
  const sent = new Date(created);
  const isToday =
    sent.getFullYear() === now.getFullYear() &&
    sent.getMonth() === now.getMonth() &&
    sent.getDate() === now.getDate();

  if (isToday || created > now.getTime()) return formatClockTime(created);

  const days = Math.round(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(sent.getFullYear(), sent.getMonth(), sent.getDate())) /
      86_400_000
  );
  const [count, unit] =
    days >= 365
      ? [Math.floor(days / 365), 'year']
      : days >= 30
        ? [Math.floor(days / 30), 'month']
        : days >= 7
          ? [Math.floor(days / 7), 'week']
          : [days, 'day'];
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
