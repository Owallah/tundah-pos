/** Type-only shim so the Deno bundle can resolve the Cents brand. */
export type Cents = number & { readonly __brand: 'Cents' };
export const cents = (n: number): Cents => {
  if (!Number.isInteger(n)) throw new RangeError(`Money must be integer cents: ${n}`);
  return n as Cents;
};
/** Daraja reports whole shillings as strings. One conversion point. */
export const shillingsToCents = (v: string | number): Cents =>
  cents(Math.round(Number(v) * 100));
