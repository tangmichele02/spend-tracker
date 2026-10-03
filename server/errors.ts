export class BadRequest extends Error {}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new BadRequest(message)
}
