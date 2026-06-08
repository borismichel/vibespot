import * as p from "@clack/prompts";
import { theme } from "../cli/theme.js";

export function isCancel(value: unknown): value is symbol {
  return p.isCancel(value);
}

export function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel(theme.muted("Operation cancelled."));
    process.exit(0);
  }
}

export async function intro(title: string): Promise<void> {
  p.intro(theme.heading(title));
}

export async function outro(message: string): Promise<void> {
  p.outro(theme.success(message));
}

export async function note(message: string, title?: string): Promise<void> {
  p.note(message, title ? theme.heading(title) : undefined);
}

export async function text(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const validate = opts.validate;
  const result = await p.text({
    message: theme.accent(opts.message),
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    // @clack passes `string | undefined`; normalise to a string for our callers.
    validate: validate ? (value) => validate(value ?? "") : undefined,
  });
  handleCancel(result);
  return result as string;
}

export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  const result = await p.confirm({
    message: theme.accent(opts.message),
    initialValue: opts.initialValue ?? true,
  });
  handleCancel(result);
  return result as boolean;
}

export async function select<T extends string>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
}): Promise<T> {
  const result = await p.select({
    message: theme.accent(opts.message),
    // Our options match clack's Primitive-`Option` shape; the cast resolves the
    // generic conditional type that TS can't narrow for an unresolved `T`.
    options: opts.options as p.Option<T>[],
  });
  handleCancel(result);
  return result as T;
}

export async function spinner(): Promise<{
  start: (msg: string) => void;
  stop: (msg: string) => void;
  message: (msg: string) => void;
}> {
  const s = p.spinner();
  return {
    start: (msg: string) => s.start(theme.muted(msg)),
    stop: (msg: string) => s.stop(theme.success(msg)),
    message: (msg: string) => s.message(theme.muted(msg)),
  };
}

export function log(message: string): void {
  p.log.info(message);
}

export function logSuccess(message: string): void {
  p.log.success(theme.success(message));
}

export function logWarn(message: string): void {
  p.log.warn(theme.warn(message));
}

export function logError(message: string): void {
  p.log.error(theme.error(message));
}

export function logStep(message: string): void {
  p.log.step(theme.accent(message));
}
