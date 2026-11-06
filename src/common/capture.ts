export interface ReadWindow { startedAt: number; finishedAt: number }
export interface CaptureTiming { image: ReadWindow; elements?: ReadWindow }
export interface ScreenRead {
  path: string;
  timestamp: number;
  captureTiming: CaptureTiming;
  elements?: string;
  elementsError?: string;
}
