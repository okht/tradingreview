export const PAGE_SIZE = 10;

export function paginationWindow(total, page = 1) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const size = PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(count / size));
  const current = Math.min(pageCount, Math.max(1, Math.floor(Number(page) || 1)));
  return { page: current, pageSize: size, pageCount, start: (current - 1) * size, end: Math.min(current * size, count) };
}

export function paginationItems(page, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, 'next-gap', pageCount];
  if (page >= pageCount - 3) return [1, 'previous-gap', ...Array.from({ length: 5 }, (_, i) => pageCount - 4 + i)];
  return [1, 'previous-gap', page - 1, page, page + 1, 'next-gap', pageCount];
}
