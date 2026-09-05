// Placeholder entry so the test Worker has a main module; replaced in Task 6.
export default {
  async fetch(): Promise<Response> {
    return new Response("not yet", { status: 501 });
  },
};
