import { type ApiRouteHandler } from "../http";

export const handleEventTransportRequest: ApiRouteHandler = async (context, request, response, url) => {
  if (request.method !== "GET" || url.pathname !== "/events") {
    return false;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  response.write("\n");

  const unsubscribe = context.store.subscribe(response);
  const keepAlive = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, 15_000);

  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
  return true;
};

