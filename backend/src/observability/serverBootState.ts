export const SERVER_BOOT_ID = `${Date.now()}-${process.pid}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
