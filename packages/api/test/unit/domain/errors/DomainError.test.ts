import { describe, expect, it } from "vitest";
import { DomainError } from "../../../../src/domain/errors/DomainError.js";
import { InvalidEvent } from "../../../../src/domain/errors/InvalidEvent.js";
import { InvalidHold } from "../../../../src/domain/errors/InvalidHold.js";
import { InvalidMoney } from "../../../../src/domain/errors/InvalidMoney.js";
import { InvalidOrder } from "../../../../src/domain/errors/InvalidOrder.js";
import { InvalidQuantity } from "../../../../src/domain/errors/InvalidQuantity.js";
import { InvalidTicketTier } from "../../../../src/domain/errors/InvalidTicketTier.js";

// TB-012's single error handler will key on the class; logs will show `name`.
describe("domain errors", () => {
  it.each([
    InvalidEvent,
    InvalidHold,
    InvalidMoney,
    InvalidOrder,
    InvalidQuantity,
    InvalidTicketTier,
  ])("$name is a DomainError and an Error carrying its own class name", (ErrorClass) => {
    const error = new ErrorClass("why");

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.constructor).toBe(ErrorClass);
    expect(error.name).toBe(ErrorClass.name);
    expect(error.message).toBe("why");
  });
});
