// Base of every typed domain error. TB-012's single Fastify error handler maps
// subclasses to HTTP status codes; `name` is what shows up in logs.
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
