export class LatestRequestGate {
  private latestRequestId = 0;

  start(): number {
    this.latestRequestId += 1;
    return this.latestRequestId;
  }

  isLatest(requestId: number): boolean {
    return requestId === this.latestRequestId;
  }
}
