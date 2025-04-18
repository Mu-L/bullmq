import { SpanKind } from '../enums';

/**
 * Telemetry interface
 *
 * This interface allows third-party libraries to integrate their own telemetry
 * system. The interface is heavily inspired by OpenTelemetry but it's not
 * limited to it.
 *
 */
export interface Telemetry<Context = any> {
  /**
   * Tracer instance
   *
   * The tracer is responsible for creating spans and propagating the context
   * across the application.
   */
  tracer: Tracer<Context>;

  /**
   * Context manager instance
   *
   * The context manager is responsible for managing the context and propagating
   * it across the application.
   */
  contextManager: ContextManager;
}

/**
 * Context manager interface
 *
 * The context manager is responsible for managing the context and propagating
 * it across the application.
 */
export interface ContextManager<Context = any> {
  /**
   * Creates a new context and sets it as active for the fn passed as last argument
   *
   * @param context - the context to set as active
   * @param fn - the function to execute with the context
   */
  with<A extends (...args: any[]) => any>(
    context: Context,
    fn: A,
  ): ReturnType<A>;

  /**
   * Returns the active context
   */
  active(): Context;

  /**
   * Returns a serialized version of the current context. The metadata
   * is the mechanism used to propagate the context across a distributed
   * application.
   *
   * @param context - the current context
   */
  getMetadata(context: Context): string;

  /**
   * Creates a new context from a serialized version effectively
   * linking the new context to the parent context.
   *
   * @param activeContext - the current active context
   * @param metadata - the serialized version of the context
   */
  fromMetadata(activeContext: Context, metadata: string): Context;
}

/**
 * Tracer interface
 *
 */
export interface Tracer<Context = any> {
  /**
   * startSpan creates a new Span with the given name and options on an optional
   * context. If the context is not provided, the current active context should be
   * used.
   *
   * @param name - span name
   * @param options - span options
   * @param context - optional context
   * @returns - the created span
   */
  startSpan(name: string, options?: SpanOptions, context?: Context): Span;
}

export interface SpanOptions {
  kind: SpanKind;
}

/**
 * Span interface
 */
export interface Span<Context = any> {
  /**
   * setSpanOnContext sets the span on the context. This is useful when you want
   * to propagate the span across the application.
   *
   * @param ctx - context to set the span on
   * @returns - the context with the span set on it
   */
  setSpanOnContext(ctx: Context): Context;

  /**
   * setAttribute sets an attribute on the span.
   *
   * @param key - attribute key
   * @param value - attribute value
   */
  setAttribute(key: string, value: AttributeValue): void;

  /**
   * setAttributes sets multiple attributes on the span.
   *
   * @param attributes - attributes to set
   */
  setAttributes(attributes: Attributes): void;

  /**
   * addEvent adds an event to the span.
   *
   * @param name - event name
   * @param attributes - event attributes
   */
  addEvent(name: string, attributes?: Attributes): void;

  /**
   * recordException records an exception on the span.
   *
   * @param exception - exception to record
   * @param time - time to record the exception
   */
  recordException(exception: Exception, time?: Time): void;

  /**
   * end ends the span.
   *
   * Note: spans must be ended so that they can be exported.
   */
  end(): void;
}

export interface Attributes {
  [attribute: string]: AttributeValue | undefined;
}

export type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

export type Exception = string | ExceptionType;

export type ExceptionType = CodeException | MessageException | NameException;

interface CodeException {
  code: string | number;
  name?: string;
  message?: string;
  stack?: string;
}

interface MessageException {
  code?: string | number;
  name?: string;
  message: string;
  stack?: string;
}

interface NameException {
  code?: string | number;
  name: string;
  message?: string;
  stack?: string;
}

export type Time = HighResolutionTime | number | Date;

type HighResolutionTime = [number, number];
