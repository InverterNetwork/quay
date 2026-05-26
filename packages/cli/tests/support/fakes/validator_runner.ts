import type {
  ValidatorRunner,
  ValidatorRunResult,
} from "../../../src/core/validator_runner.ts";
import type { ValidationError } from "../../../src/validator/types.ts";

// In-process stand-in for the spawned validator. Most tests don't care that
// validation runs in a subprocess (just that it ran with the right payload);
// they get a fast, deterministic substitute. The single child-process
// integration test wires `SpawnedValidatorRunner` directly instead.
export class FakeValidatorRunner implements ValidatorRunner {
  runCalls: { payload: unknown; rawPayload: string }[] = [];
  private response: ValidatorRunResult = {
    valid: true,
    errors: [],
    exitCode: 0,
    stdout: '{"valid":true}\n',
    stderr: "",
  };

  setValid(): void {
    this.response = {
      valid: true,
      errors: [],
      exitCode: 0,
      stdout: '{"valid":true}\n',
      stderr: "",
    };
  }

  setInvalid(errors: ValidationError[]): void {
    this.response = {
      valid: false,
      errors,
      exitCode: 1,
      stdout: `${JSON.stringify({ valid: false, errors })}\n`,
      stderr: "",
    };
  }

  run(payload: unknown): ValidatorRunResult {
    this.runCalls.push({ payload, rawPayload: JSON.stringify(payload) });
    return this.response;
  }
}
