// Errors reported to the client with tsc's message prefixes.

export class ApiError extends Error {}

// An error caused by the request rather than the server.
export class ClientError extends ApiError {
  constructor(message: string) {
    super(`api: client error: ${message}`);
  }
}

// A request the server can't parse or doesn't know.
export class InvalidRequestError extends ApiError {
  constructor(message: string) {
    super(`api: invalid request: ${message}`);
  }
}
