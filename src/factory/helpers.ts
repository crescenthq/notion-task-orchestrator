type JsonObject = Record<string, unknown>;

export type ActionStatus = "done" | "feedback" | "failed";

export type PageOutput = string | { markdown: string; body?: string };

export type RoutedResult<TStatus extends string = string, TData extends JsonObject = JsonObject> = {
  status: TStatus;
  data?: TData;
  message?: string;
};

export type ActionResult<TData extends JsonObject = JsonObject> = RoutedResult<ActionStatus, TData> & {
  page?: PageOutput;
};

export type Agent<Input = unknown, Result extends RoutedResult = RoutedResult> =
  (input: Input) => Result | Promise<Result>;

export type Selector<Input = unknown, Event extends string = string> =
  (input: Input) => Event | Promise<Event>;

export type Until<Input = unknown> = (input: Input) => boolean | Promise<boolean>;

export function agent<Input = unknown, Result extends RoutedResult = RoutedResult>(
  fn: Agent<Input, Result>,
): Agent<Input, Result> {
  return fn;
}

export function select<Input = unknown, Event extends string = string>(
  fn: Selector<Input, Event>,
): Selector<Input, Event> {
  return fn;
}

export function until<Input = unknown>(fn: Until<Input>): Until<Input> {
  return fn;
}
