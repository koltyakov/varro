export class OpenCodeResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`OpenCode response exceeded the ${maxBytes}-byte safety limit`);
    this.name = 'OpenCodeResponseTooLargeError';
  }
}
