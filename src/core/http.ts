/** The one outbound transport Ulak uses in production.
 *
 *  Bound to the global scope on purpose. An unbound `fetch` works when called as a bare
 *  function but throws "Illegal invocation" the moment it is stored on an object and called
 *  as a method, which is how TelegramNotifier calls it. The first deployment failed exactly
 *  this way while every test passed, because every test injected its own transport. Anything
 *  that takes an injectable `fetch` defaults to this value, so one probe covers them all.
 */
export const defaultFetch: typeof fetch = fetch.bind(globalThis);
