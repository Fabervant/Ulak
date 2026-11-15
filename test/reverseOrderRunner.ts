// The reverse-order run. The leak detector (test/setup.ts) names a test that leaves state behind; the other half of
// an order dependence is a test that NEEDS an earlier one to have run. Running every block's tests (and every file's
// blocks) last to first finds those in one deterministic run. Loaded only when ULAK_TEST_ORDER=reverse
// (vitest.config.ts); an ordinary run never loads it.
import { TestRunner, type RunnerTestSuite } from "vitest";

export default class ReverseOrderRunner extends TestRunner {
  override async onBeforeRunSuite(suite: RunnerTestSuite): Promise<void> {
    suite.tasks.reverse();
    await super.onBeforeRunSuite(suite);
  }
}
