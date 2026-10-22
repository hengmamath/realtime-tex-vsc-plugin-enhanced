interface TextExpectations {
  has: string[];
  lacks: string[];
  stable: string[];
}

const count = (text: string, token: string) => text.split(token).length - 1;

/** Checks model snapshots after delivery, not pixels or browser animation frames. */
export class ModelTextChecks {
  stableBroken = 0;
  duplicated = 0;

  constructor(private readonly expected: TextExpectations) {}

  observe(text: string): void {
    if (this.expected.stable.some((s) => !text.includes(s))) this.stableBroken++;
    if ([...this.expected.stable, ...this.expected.has].some((s) => count(text, s) > 1)) this.duplicated++;
  }

  problems(finalText: string): string[] {
    const problems: string[] = [];
    if (this.stableBroken) problems.push(`preview model lost stable text in ${this.stableBroken} snapshots`);
    if (this.duplicated) problems.push(`preview model duplicated text in ${this.duplicated} snapshots`);
    for (const s of [...this.expected.stable, ...this.expected.has]) {
      if (!finalText.includes(s)) problems.push(`final model lacks ${s}`);
      if (count(finalText, s) > 1) problems.push(`final model shows ${s} twice`);
    }
    for (const s of this.expected.lacks) if (finalText.includes(s)) problems.push(`final model still shows ${s}`);
    return problems;
  }
}
