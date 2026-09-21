// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// packages/workflow-cli/src/adapters/native.ts
import { randomUUID as randomUUID2 } from "crypto";
import { lstatSync as lstatSync4 } from "fs";
import { homedir } from "os";
import { isAbsolute as isAbsolute4, join as join4 } from "path";

// packages/workflow-cli/src/diagnostics.ts
import { AsyncLocalStorage } from "async_hooks";
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "fs";
import { isAbsolute, join, sep } from "path";
// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/context.js
var categoryPrefixSymbol = Symbol.for("logtape.categoryPrefix");
function getCategoryPrefix() {
  const rootLogger = LoggerImpl.getLogger();
  const store = rootLogger.contextLocalStorage?.getStore();
  if (store == null)
    return [];
  const prefix = store[categoryPrefixSymbol];
  return Array.isArray(prefix) ? prefix : [];
}
function getImplicitContextIfAny() {
  const rootLogger = LoggerImpl.getLogger();
  const store = rootLogger.contextLocalStorage?.getStore();
  if (store == null)
    return;
  const keys = Object.keys(store);
  if (keys.length < 1)
    return;
  const result = {};
  for (const key of keys)
    result[key] = store[key];
  return result;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/level.js
var logLevels = [
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal"
];
function isLogLevel(level) {
  switch (level) {
    case "trace":
    case "debug":
    case "info":
    case "warning":
    case "error":
    case "fatal":
      return true;
    default:
      return false;
  }
}
function compareLogLevel(a, b) {
  const aIndex = logLevels.indexOf(a);
  if (aIndex < 0)
    throw new TypeError(`Invalid log level: ${JSON.stringify(a)}.`);
  const bIndex = logLevels.indexOf(b);
  if (bIndex < 0)
    throw new TypeError(`Invalid log level: ${JSON.stringify(b)}.`);
  return aIndex - bIndex;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/filter.js
function toFilter(filter) {
  if (typeof filter === "function")
    return filter;
  return getLevelFilter(filter);
}
function getLevelFilter(level) {
  if (level == null)
    return () => false;
  if (level === "fatal")
    return (record) => record.level === "fatal";
  else if (level === "error")
    return (record) => record.level === "fatal" || record.level === "error";
  else if (level === "warning")
    return (record) => record.level === "fatal" || record.level === "error" || record.level === "warning";
  else if (level === "info")
    return (record) => record.level === "fatal" || record.level === "error" || record.level === "warning" || record.level === "info";
  else if (level === "debug")
    return (record) => record.level === "fatal" || record.level === "error" || record.level === "warning" || record.level === "info" || record.level === "debug";
  else if (level === "trace")
    return () => true;
  throw new TypeError(`Invalid log level: ${level}.`);
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/scoped-config.js
var scopedConfigSymbol = Symbol.for("logtape.scopedConfig");
var defaultScopedLogger = {
  filters: [],
  lowestLevel: "trace",
  parentSinks: "inherit",
  sinks: []
};
var noFilters = [];
function compileScopedConfig(config, allowAsync, createError) {
  if (!isObjectLike(config))
    throw createError("Configuration must be an object.");
  if (!isObjectLike(config.sinks))
    throw createError("Configuration must include a sinks object.");
  if (!Array.isArray(config.loggers))
    throw createError("Configuration must include a loggers array.");
  if (config.filters !== undefined && !isObjectLike(config.filters))
    throw createError("Configuration filters must be an object.");
  const nodes = /* @__PURE__ */ new Map;
  const configuredCategories = /* @__PURE__ */ new Set;
  for (const logger of config.loggers) {
    if (!isObjectLike(logger))
      throw createError("Logger configuration must be an object.");
    const loggerConfig = logger;
    const category = normalizeCategory(loggerConfig.category, createError);
    if (loggerConfig.sinks !== undefined && !Array.isArray(loggerConfig.sinks))
      throw createError("Logger sinks must be an array.");
    if (loggerConfig.filters !== undefined && !Array.isArray(loggerConfig.filters))
      throw createError("Logger filters must be an array.");
    if (loggerConfig.parentSinks !== undefined && loggerConfig.parentSinks !== "inherit" && loggerConfig.parentSinks !== "override")
      throw createError('Logger parentSinks must be "inherit" or "override".');
    if (loggerConfig.lowestLevel !== undefined && loggerConfig.lowestLevel !== null && !isLogLevel(loggerConfig.lowestLevel))
      throw createError("Logger lowestLevel must be a log level or null.");
    const key = categoryKey(category);
    if (configuredCategories.has(key))
      throw createError(`Duplicate logger configuration for category: ${key}. Each category can only be configured once.`);
    configuredCategories.add(key);
    const sinks = [];
    const sinkIds = loggerConfig.sinks ?? [];
    for (const sinkId of sinkIds) {
      const sink = config.sinks[sinkId];
      if (!sink)
        throw createError(`Sink not found: ${sinkId}.`);
      if (typeof sink !== "function")
        throw createError(`Sink must be a function: ${sinkId}.`);
      sinks.push(sink);
    }
    const filters = [];
    const filterIds = loggerConfig.filters ?? [];
    for (const filterId of filterIds) {
      const filter = config.filters?.[filterId];
      if (filter === undefined)
        throw createError(`Filter not found: ${filterId}.`);
      if (!isFilterLike(filter))
        throw createError(`Filter must be a function, log level, or null: ${filterId}.`);
      filters.push(toFilter(filter));
    }
    nodes.set(key, {
      filters,
      lowestLevel: loggerConfig.lowestLevel === undefined ? "trace" : loggerConfig.lowestLevel,
      parentSinks: loggerConfig.parentSinks ?? "inherit",
      sinks
    });
  }
  const syncFilters = /* @__PURE__ */ new Set;
  const asyncFilters = /* @__PURE__ */ new Set;
  const syncSinks = /* @__PURE__ */ new Set;
  const asyncSinks = /* @__PURE__ */ new Set;
  for (const sink of Object.values(config.sinks)) {
    if (!isObjectLike(sink))
      continue;
    if (Symbol.asyncDispose in sink) {
      if (!allowAsync)
        throw createError("Async disposables cannot be used with withConfigSync().");
      asyncSinks.add(sink);
    } else if (Symbol.dispose in sink)
      syncSinks.add(sink);
  }
  for (const filter of Object.values(config.filters ?? {})) {
    if (!isObjectLike(filter))
      continue;
    if (Symbol.asyncDispose in filter) {
      if (!allowAsync)
        throw createError("Async disposables cannot be used with withConfigSync().");
      asyncFilters.add(filter);
      asyncSinks.delete(filter);
    } else if (Symbol.dispose in filter) {
      syncFilters.add(filter);
      syncSinks.delete(filter);
    }
  }
  return {
    asyncFilters,
    asyncSinks,
    dispatchCache: /* @__PURE__ */ new Map,
    disposed: false,
    filterCache: /* @__PURE__ */ new Map,
    nodes,
    parent: undefined,
    syncFilters,
    syncSinks
  };
}
function getCurrentScopedConfig(contextLocalStorage) {
  const store = contextLocalStorage?.getStore();
  const scopedConfig = store?.[scopedConfigSymbol];
  return isCompiledScopedConfig(scopedConfig) ? getActiveScopedConfig(scopedConfig) : undefined;
}
function runWithScopedConfig(contextLocalStorage, scopedConfig, callback) {
  const parentStore = contextLocalStorage.getStore() ?? {};
  scopedConfig.parent = getCurrentScopedConfig(contextLocalStorage);
  return contextLocalStorage.run({
    ...parentStore,
    [scopedConfigSymbol]: scopedConfig
  }, callback);
}
function scopedConfigHasSink(scopedConfig, category, level) {
  return getScopedSinkDispatchPlan(scopedConfig, category, level).kind !== "none";
}
function emitWithScopedConfig(scopedConfig, record, bypassSinks, emitToSink) {
  const plan = getScopedSinkDispatchPlan(scopedConfig, record.category, record.level);
  if (plan.kind === "none")
    return;
  if (!filterScopedRecord(scopedConfig, record.category, record))
    return;
  if (plan.kind === "one") {
    if (!bypassSinks?.has(plan.sink))
      emitToSink(plan.sink, bypassSinks);
    return;
  }
  for (const sink of plan.sinks) {
    if (bypassSinks?.has(sink))
      continue;
    emitToSink(sink, bypassSinks);
  }
}
function disposeScopedConfigSync(scopedConfig, retainedDisposables) {
  const parentDisposables = getParentScopedDisposables(scopedConfig, retainedDisposables);
  scopedConfig.disposed = true;
  const errors = [];
  try {
    disposeSyncDisposables(scopedConfig.syncFilters, parentDisposables);
  } catch (error) {
    errors.push(error);
  }
  try {
    disposeSyncDisposables(scopedConfig.syncSinks, parentDisposables);
  } catch (error) {
    errors.push(error);
  }
  throwDisposeErrors(errors);
}
function throwCombinedErrors(primary, secondary) {
  throw new AggregateError(flattenErrors(primary, secondary), "Multiple errors occurred while running LogTape scoped configuration.");
}
function isCompiledScopedConfig(value) {
  return value != null && typeof value === "object" && "nodes" in value;
}
function isObjectLike(value) {
  return value != null && (typeof value === "object" || typeof value === "function");
}
function isFilterLike(value) {
  return value == null || typeof value === "function" || typeof value === "string" && isLogLevel(value);
}
function getActiveScopedConfig(scopedConfig) {
  let activeConfig = scopedConfig;
  while (activeConfig?.disposed)
    activeConfig = activeConfig.parent;
  return activeConfig;
}
function getParentScopedDisposables(scopedConfig, extraRetained) {
  const disposables = new Set(extraRetained);
  let parent = scopedConfig.parent;
  while (parent != null) {
    const activeParent = getActiveScopedConfig(parent);
    if (activeParent == null)
      break;
    addScopedDisposables(disposables, activeParent);
    parent = activeParent.parent;
  }
  return disposables;
}
function addScopedDisposables(disposables, scopedConfig) {
  for (const disposable of scopedConfig.syncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.syncSinks)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncSinks)
    disposables.add(disposable);
}
function normalizeCategory(category, createError) {
  if (typeof category === "string")
    return [category];
  if (!Array.isArray(category))
    throw createError("Logger category must be a string or array of strings.");
  if (category.some((part) => typeof part !== "string"))
    throw createError("Logger category must only contain strings.");
  return [...category];
}
function categoryKey(category) {
  return JSON.stringify(category);
}
function getScopedSinkDispatchPlan(scopedConfig, category, level) {
  const cacheKey = `${categoryKey(category)}:${level}`;
  let plan = scopedConfig.dispatchCache.get(cacheKey);
  if (plan == null) {
    plan = getScopedSinkDispatchPlanForPrefix(scopedConfig, category, category.length, level);
    scopedConfig.dispatchCache.set(cacheKey, plan);
  }
  return plan;
}
function getScopedSinkDispatchPlanForPrefix(scopedConfig, category, length, level) {
  const prefix = category.slice(0, length);
  const logger = scopedConfig.nodes.get(categoryKey(prefix)) ?? defaultScopedLogger;
  if (logger.lowestLevel === null || compareLogLevel(level, logger.lowestLevel) < 0)
    return { kind: "none" };
  const parentPlan = length > 0 && logger.parentSinks === "inherit" ? getScopedSinkDispatchPlanForPrefix(scopedConfig, category, length - 1, level) : { kind: "none" };
  let firstSink;
  let sinks;
  const appendSink = (sink) => {
    if (sinks != null)
      sinks.push(sink);
    else if (firstSink == null)
      firstSink = sink;
    else
      sinks = [firstSink, sink];
  };
  if (parentPlan.kind === "one")
    appendSink(parentPlan.sink);
  else if (parentPlan.kind === "many")
    for (const sink of parentPlan.sinks)
      appendSink(sink);
  for (const sink of logger.sinks)
    appendSink(sink);
  if (sinks != null)
    return {
      kind: "many",
      sinks
    };
  if (firstSink != null)
    return {
      kind: "one",
      sink: firstSink
    };
  return { kind: "none" };
}
function filterScopedRecord(scopedConfig, category, record) {
  const key = categoryKey(category);
  let filters = scopedConfig.filterCache.get(key);
  if (filters == null) {
    filters = getScopedFilters(scopedConfig, category);
    scopedConfig.filterCache.set(key, filters);
  }
  return filters.every((filter) => filter(record));
}
function getScopedFilters(scopedConfig, category) {
  for (let length = category.length;length >= 0; length--) {
    const logger = scopedConfig.nodes.get(categoryKey(category.slice(0, length)));
    if (logger == null || logger.filters.length < 1)
      continue;
    return logger.filters;
  }
  return noFilters;
}
function disposeSyncDisposables(disposables, retainedDisposables) {
  const disposableList = filterRetainedDisposables(disposables, retainedDisposables);
  const errors = [];
  try {
    for (const disposable of disposableList)
      try {
        disposable[Symbol.dispose]();
      } catch (error) {
        errors.push(error);
      }
  } finally {
    disposables.clear();
  }
  throwDisposeErrors(errors);
}
function filterRetainedDisposables(disposables, retainedDisposables) {
  return Array.from(disposables).filter((disposable) => !retainedDisposables.has(disposable));
}
function throwDisposeErrors(errors) {
  if (errors.length < 1)
    return;
  if (errors.length === 1)
    throw errors[0];
  throw new AggregateError(errors, "Multiple errors occurred while disposing LogTape scoped resources.");
}
function flattenErrors(...errors) {
  const flattened = [];
  for (const error of errors)
    if (error instanceof AggregateError)
      flattened.push(...error.errors);
    else
      flattened.push(error);
  return flattened;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/logger.js
var lazySymbol = Symbol.for("logtape.lazy");
var throttlingSummaryRecordSymbol = Symbol.for("LogTape.throttlingSummaryRecord");
var immediateSinkSymbol = Symbol.for("LogTape.sinkSnapshotPolicy.immediate");
var internalStringLogRecords = /* @__PURE__ */ new WeakSet;
var resolvedStringLogRecords = /* @__PURE__ */ new WeakSet;
function isLazy(value) {
  return value != null && typeof value === "object" && lazySymbol in value && value[lazySymbol] === true;
}
function resolveProperties(properties) {
  const resolved = {};
  for (const key in properties) {
    const value = properties[key];
    resolved[key] = isLazy(value) ? value.getter() : value;
  }
  const symbolProperties = properties;
  const symbolResolved = resolved;
  if (Object.prototype.propertyIsEnumerable.call(properties, throttlingSummaryRecordSymbol)) {
    const value = symbolProperties[throttlingSummaryRecordSymbol];
    symbolResolved[throttlingSummaryRecordSymbol] = isLazy(value) ? value.getter() : value;
  }
  return resolved;
}
function isPromiseObject(value) {
  if (value instanceof Promise)
    return true;
  return Object.prototype.toString.call(value) === "[object Promise]" && typeof value.then === "function";
}
function logStringMessage(logger, level, message, props) {
  if (typeof props !== "function") {
    const properties = props ?? {};
    logger.log(level, message, properties);
    return;
  }
  if (!logger.isEnabledFor(level))
    return Promise.resolve();
  const result = props();
  if (isPromiseObject(result))
    return Promise.resolve(result).then((resolvedProps) => {
      logger.log(level, message, resolvedProps);
    });
  logger.log(level, message, result);
}
function snapshotLogRecordProperties(record) {
  if (resolvedStringLogRecords.has(record))
    return record;
  const properties = resolveProperties(record.properties);
  if (internalStringLogRecords.has(record))
    return {
      category: record.category,
      level: record.level,
      get message() {
        return record.message;
      },
      rawMessage: record.rawMessage,
      timestamp: record.timestamp,
      properties
    };
  const descriptors = Object.getOwnPropertyDescriptors(record);
  descriptors.properties = {
    value: properties,
    enumerable: true,
    configurable: true
  };
  return Object.defineProperties({}, descriptors);
}
function hasEnumerableProperties(properties) {
  if (properties == null || typeof properties !== "object")
    return false;
  return Object.keys(properties).length > 0 || Object.prototype.propertyIsEnumerable.call(properties, throttlingSummaryRecordSymbol);
}
function shouldSnapshotForSink(sink) {
  return sink[immediateSinkSymbol] !== true;
}
function getLogger(category = []) {
  return LoggerImpl.getLogger(category);
}
var globalRootLoggerSymbol = Symbol.for("logtape.rootLogger");
function isMetaLoggerCategory(category) {
  return category.length >= 2 && category[0] === "logtape" && category[1] === "meta";
}
var LoggerImpl = class LoggerImpl2 {
  parent;
  children;
  category;
  sinks;
  filters;
  contextLocalStorage;
  #parentSinks = "inherit";
  #lowestLevel = "trace";
  #sinkPlanCache = {};
  static getLogger(category = []) {
    let rootLogger = globalRootLoggerSymbol in globalThis ? globalThis[globalRootLoggerSymbol] ?? null : null;
    if (rootLogger == null) {
      rootLogger = new LoggerImpl2(null, []);
      globalThis[globalRootLoggerSymbol] = rootLogger;
    }
    if (typeof category === "string")
      return rootLogger.getChild(category);
    if (category.length === 0)
      return rootLogger;
    return rootLogger.getChild(category);
  }
  static getNearestExistingLogger(category) {
    let logger = LoggerImpl2.getLogger();
    for (const name of category) {
      const childRef = logger.children[name];
      const child = childRef instanceof LoggerImpl2 ? childRef : childRef?.deref();
      if (child == null)
        break;
      logger = child;
    }
    return logger;
  }
  constructor(parent, category) {
    this.parent = parent;
    this.children = {};
    this.category = category;
    this.sinks = [];
    this.filters = [];
  }
  get parentSinks() {
    return this.#parentSinks;
  }
  set parentSinks(value) {
    if (this.#parentSinks === value)
      return;
    this.#parentSinks = value;
  }
  get lowestLevel() {
    return this.#lowestLevel;
  }
  set lowestLevel(value) {
    if (this.#lowestLevel === value)
      return;
    this.#lowestLevel = value;
  }
  getChild(subcategory) {
    const name = typeof subcategory === "string" ? subcategory : subcategory[0];
    const childRef = this.children[name];
    let child = childRef instanceof LoggerImpl2 ? childRef : childRef?.deref();
    if (child == null) {
      child = new LoggerImpl2(this, [...this.category, name]);
      this.children[name] = "WeakRef" in globalThis ? new WeakRef(child) : child;
    }
    if (typeof subcategory === "string" || subcategory.length === 1)
      return child;
    return child.getChild(subcategory.slice(1));
  }
  reset() {
    while (this.sinks.length > 0)
      this.sinks.shift();
    this.parentSinks = "inherit";
    while (this.filters.length > 0)
      this.filters.shift();
    this.lowestLevel = "trace";
  }
  resetDescendants() {
    for (const child of Object.values(this.children)) {
      const logger = child instanceof LoggerImpl2 ? child : child.deref();
      if (logger != null)
        logger.resetDescendants();
    }
    this.reset();
  }
  with(properties) {
    return new LoggerCtx(this, { ...properties });
  }
  filter(record) {
    for (const filter of this.filters)
      if (!filter(record))
        return false;
    if (this.filters.length < 1)
      return this.parent?.filter(record) ?? true;
    return true;
  }
  *getSinks(level) {
    const plan = this.getSinkDispatchPlan(level);
    switch (plan.kind) {
      case "none":
        return;
      case "one":
        yield plan.sink;
        return;
      case "many":
        yield* plan.sinks;
        return;
    }
  }
  getSinkDispatchPlan(level) {
    const cached = this.#sinkPlanCache[level];
    if (cached != null && this.isSinkDispatchPlanFresh(level, cached))
      return cached;
    const parentPlan = this.parent != null && this.parentSinks === "inherit" ? this.parent.getSinkDispatchPlan(level) : undefined;
    const plan = this.createSinkDispatchPlan(level, parentPlan);
    this.#sinkPlanCache[level] = plan;
    return plan;
  }
  isSinkDispatchPlanFresh(level, plan) {
    if (plan.lowestLevel !== this.lowestLevel || plan.parentSinks !== this.parentSinks || plan.localSinks.length !== this.sinks.length)
      return false;
    for (let i = 0;i < plan.localSinks.length; i++)
      if (plan.localSinks[i] !== this.sinks[i])
        return false;
    const parentPlan = this.parent != null && this.parentSinks === "inherit" ? this.parent.getSinkDispatchPlan(level) : undefined;
    return plan.parentPlan === parentPlan;
  }
  createSinkDispatchPlan(level, parentPlan) {
    const state = {
      localSinks: [...this.sinks],
      parentSinks: this.parentSinks,
      lowestLevel: this.lowestLevel,
      parentPlan
    };
    if (state.lowestLevel === null)
      return {
        ...state,
        kind: "none"
      };
    if (compareLogLevel(level, state.lowestLevel) < 0)
      return {
        ...state,
        kind: "none"
      };
    let firstSink;
    let sinks;
    const appendSink = (sink) => {
      if (sinks != null)
        sinks.push(sink);
      else if (firstSink == null)
        firstSink = sink;
      else
        sinks = [firstSink, sink];
    };
    if (parentPlan != null) {
      if (parentPlan.kind === "one")
        firstSink = parentPlan.sink;
      else if (parentPlan.kind === "many")
        sinks = [...parentPlan.sinks];
    }
    for (const sink of state.localSinks)
      appendSink(sink);
    if (sinks != null)
      return {
        ...state,
        kind: "many",
        sinks
      };
    if (firstSink != null)
      return {
        ...state,
        kind: "one",
        sink: firstSink
      };
    return {
      ...state,
      kind: "none"
    };
  }
  isEnabledFor(level) {
    const categoryPrefix = isMetaLoggerCategory(this.category) ? [] : getCategoryPrefix();
    const dispatcher = categoryPrefix.length > 0 ? LoggerImpl2.getNearestExistingLogger([...categoryPrefix, ...this.category]) : this;
    const scopedConfig = getCurrentScopedConfig(LoggerImpl2.getLogger().contextLocalStorage);
    if (scopedConfig != null)
      return scopedConfigHasSink(scopedConfig, categoryPrefix.length > 0 ? [...categoryPrefix, ...this.category] : this.category, level);
    return dispatcher.isEnabledForResolved(level);
  }
  isEnabledForResolved(level) {
    return this.getSinkDispatchPlan(level).kind !== "none";
  }
  emit(record, bypassSinks) {
    const hasCategory = "category" in record;
    const baseCategory = hasCategory ? record.category : this.category;
    const categoryPrefix = isMetaLoggerCategory(baseCategory) ? [] : getCategoryPrefix();
    const fullCategory = categoryPrefix.length > 0 ? [...categoryPrefix, ...baseCategory] : baseCategory;
    if (categoryPrefix.length < 1 && Object.prototype.hasOwnProperty.call(record, "category")) {
      this.emitResolved(record, bypassSinks);
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(record);
    descriptors.category = {
      value: fullCategory,
      enumerable: true,
      configurable: true
    };
    const fullRecord = Object.defineProperties({}, descriptors);
    const dispatcher = categoryPrefix.length > 0 ? LoggerImpl2.getNearestExistingLogger(fullCategory) : this;
    dispatcher.emitResolved(fullRecord, bypassSinks);
  }
  emitResolved(record, bypassSinks) {
    const scopedConfig = getCurrentScopedConfig(LoggerImpl2.getLogger().contextLocalStorage);
    if (scopedConfig != null) {
      let snapshot$1;
      let snapshotFailed$1 = false;
      emitWithScopedConfig(scopedConfig, record, bypassSinks, (sink, activeBypassSinks) => {
        try {
          if (shouldSnapshotForSink(sink))
            try {
              snapshot$1 ??= snapshotLogRecordProperties(record);
            } catch {
              snapshotFailed$1 = true;
              snapshot$1 = record;
            }
          sink(snapshot$1 ?? record);
        } catch (error) {
          const bypassSinks2 = new Set(activeBypassSinks);
          bypassSinks2.add(sink);
          metaLogger.log("fatal", "Failed to emit a log record to sink {sink}: {error}", {
            sink,
            error,
            record
          }, bypassSinks2);
        }
        if (snapshotFailed$1)
          snapshot$1 = record;
      });
      return;
    }
    if (this.lowestLevel === null || compareLogLevel(record.level, this.lowestLevel) < 0 || !this.filter(record))
      return;
    const plan = this.getSinkDispatchPlan(record.level);
    if (plan.kind === "none")
      return;
    let snapshot;
    let snapshotFailed = false;
    if (plan.kind === "one") {
      const sink = plan.sink;
      if (bypassSinks?.has(sink))
        return;
      try {
        if (shouldSnapshotForSink(sink))
          try {
            snapshot = snapshotLogRecordProperties(record);
          } catch {
            snapshotFailed = true;
            snapshot = record;
          }
        sink(snapshot ?? record);
      } catch (error) {
        const bypassSinks2 = new Set(bypassSinks);
        bypassSinks2.add(sink);
        metaLogger.log("fatal", "Failed to emit a log record to sink {sink}: {error}", {
          sink,
          error,
          record
        }, bypassSinks2);
      }
      return;
    }
    for (const sink of plan.sinks) {
      if (bypassSinks?.has(sink))
        continue;
      try {
        if (snapshot == null && !snapshotFailed && shouldSnapshotForSink(sink))
          try {
            snapshot = snapshotLogRecordProperties(record);
          } catch {
            snapshotFailed = true;
            snapshot = record;
          }
        sink(snapshot ?? record);
      } catch (error) {
        const bypassSinks2 = new Set(bypassSinks);
        bypassSinks2.add(sink);
        metaLogger.log("fatal", "Failed to emit a log record to sink {sink}: {error}", {
          sink,
          error,
          record
        }, bypassSinks2);
      }
    }
  }
  log(level, rawMessage, properties, bypassSinks) {
    const implicitContext = getImplicitContextIfAny();
    if (typeof properties !== "function" && implicitContext == null && !rawMessage.includes("{") && !hasEnumerableProperties(properties)) {
      const record$1 = {
        category: this.category,
        level,
        message: [rawMessage],
        rawMessage,
        timestamp: Date.now(),
        properties: {}
      };
      resolvedStringLogRecords.add(record$1);
      this.emit(record$1, bypassSinks);
      return;
    }
    let cachedProps = undefined;
    let cachedMessage = undefined;
    const record = typeof properties === "function" ? {
      category: this.category,
      level,
      timestamp: Date.now(),
      get message() {
        if (cachedMessage == null)
          cachedMessage = parseMessageTemplate(rawMessage, this.properties);
        return cachedMessage;
      },
      rawMessage,
      get properties() {
        if (cachedProps == null)
          cachedProps = resolveProperties({
            ...implicitContext ?? {},
            ...properties()
          });
        return cachedProps;
      }
    } : {
      category: this.category,
      level,
      timestamp: Date.now(),
      get message() {
        if (cachedMessage == null)
          cachedMessage = parseMessageTemplate(rawMessage, this.properties);
        return cachedMessage;
      },
      rawMessage,
      get properties() {
        if (cachedProps == null)
          cachedProps = resolveProperties({
            ...implicitContext ?? {},
            ...properties
          });
        return cachedProps;
      }
    };
    internalStringLogRecords.add(record);
    this.emit(record, bypassSinks);
  }
  logLazily(level, callback, properties = {}) {
    const implicitContext = getImplicitContextIfAny();
    let rawMessage = undefined;
    let msg = undefined;
    function realizeMessage() {
      if (msg == null || rawMessage == null) {
        msg = callback((tpl, ...values) => {
          rawMessage = tpl;
          return renderMessage(tpl, values);
        });
        if (rawMessage == null)
          throw new TypeError("No log record was made.");
      }
      return [msg, rawMessage];
    }
    this.emit({
      category: this.category,
      level,
      get message() {
        return realizeMessage()[0];
      },
      get rawMessage() {
        return realizeMessage()[1];
      },
      timestamp: Date.now(),
      properties: {
        ...implicitContext ?? {},
        ...properties
      }
    });
  }
  logTemplate(level, messageTemplate, values, properties = {}) {
    const implicitContext = getImplicitContextIfAny();
    this.emit({
      category: this.category,
      level,
      message: renderMessage(messageTemplate, values),
      rawMessage: messageTemplate,
      timestamp: Date.now(),
      properties: {
        ...implicitContext ?? {},
        ...properties
      }
    });
  }
  trace(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "trace", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("trace", message);
    else if (!Array.isArray(message))
      this.log("trace", "{*}", message);
    else
      this.logTemplate("trace", message, values);
  }
  debug(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "debug", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("debug", message);
    else if (!Array.isArray(message))
      this.log("debug", "{*}", message);
    else
      this.logTemplate("debug", message, values);
  }
  info(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "info", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("info", message);
    else if (!Array.isArray(message))
      this.log("info", "{*}", message);
    else
      this.logTemplate("info", message, values);
  }
  logError(level, error, props) {
    if (typeof props !== "function") {
      this.log(level, "{error.message}", {
        ...props,
        error
      });
      return;
    }
    if (!this.isEnabledFor(level))
      return Promise.resolve();
    const result = props();
    if (result instanceof Promise)
      return result.then((resolved) => {
        this.log(level, "{error.message}", {
          ...resolved,
          error
        });
      });
    this.log(level, "{error.message}", {
      ...result,
      error
    });
  }
  warn(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  warning(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  error(message, ...values) {
    if (message instanceof Error)
      return this.logError("error", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("error", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "error", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("error", message);
    else if (!Array.isArray(message))
      this.log("error", "{*}", message);
    else
      this.logTemplate("error", message, values);
  }
  fatal(message, ...values) {
    if (message instanceof Error)
      return this.logError("fatal", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("fatal", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "fatal", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("fatal", message);
    else if (!Array.isArray(message))
      this.log("fatal", "{*}", message);
    else
      this.logTemplate("fatal", message, values);
  }
};
var LoggerCtx = class LoggerCtx2 {
  logger;
  properties;
  constructor(logger, properties) {
    this.logger = logger;
    this.properties = properties;
  }
  get category() {
    return this.logger.category;
  }
  get parent() {
    return this.logger.parent;
  }
  getChild(subcategory) {
    return this.logger.getChild(subcategory).with(this.properties);
  }
  with(properties) {
    return new LoggerCtx2(this.logger, {
      ...this.properties,
      ...properties
    });
  }
  log(level, message, properties, bypassSinks) {
    const contextProps = this.properties;
    this.logger.log(level, message, typeof properties === "function" ? () => resolveProperties({
      ...contextProps,
      ...properties()
    }) : () => resolveProperties({
      ...contextProps,
      ...properties
    }), bypassSinks);
  }
  logLazily(level, callback) {
    this.logger.logLazily(level, callback, resolveProperties(this.properties));
  }
  logTemplate(level, messageTemplate, values) {
    this.logger.logTemplate(level, messageTemplate, values, resolveProperties(this.properties));
  }
  emit(record) {
    const recordWithContext = {
      ...record,
      properties: resolveProperties({
        ...this.properties,
        ...record.properties
      })
    };
    this.logger.emit(recordWithContext);
  }
  isEnabledFor(level) {
    return this.logger.isEnabledFor(level);
  }
  trace(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "trace", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("trace", message);
    else if (!Array.isArray(message))
      this.log("trace", "{*}", message);
    else
      this.logTemplate("trace", message, values);
  }
  debug(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "debug", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("debug", message);
    else if (!Array.isArray(message))
      this.log("debug", "{*}", message);
    else
      this.logTemplate("debug", message, values);
  }
  info(message, ...values) {
    if (typeof message === "string")
      return logStringMessage(this, "info", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("info", message);
    else if (!Array.isArray(message))
      this.log("info", "{*}", message);
    else
      this.logTemplate("info", message, values);
  }
  logError(level, error, props) {
    if (typeof props !== "function") {
      this.log(level, "{error.message}", {
        ...props,
        error
      });
      return;
    }
    if (!this.isEnabledFor(level))
      return Promise.resolve();
    const result = props();
    if (result instanceof Promise)
      return result.then((resolved) => {
        this.log(level, "{error.message}", {
          ...resolved,
          error
        });
      });
    this.log(level, "{error.message}", {
      ...result,
      error
    });
  }
  warn(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  warning(message, ...values) {
    if (message instanceof Error)
      return this.logError("warning", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("warning", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "warning", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("warning", message);
    else if (!Array.isArray(message))
      this.log("warning", "{*}", message);
    else
      this.logTemplate("warning", message, values);
  }
  error(message, ...values) {
    if (message instanceof Error)
      return this.logError("error", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("error", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "error", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("error", message);
    else if (!Array.isArray(message))
      this.log("error", "{*}", message);
    else
      this.logTemplate("error", message, values);
  }
  fatal(message, ...values) {
    if (message instanceof Error)
      return this.logError("fatal", message, values[0]);
    else if (typeof message === "string" && values[0] instanceof Error)
      this.log("fatal", message, { error: values[0] });
    else if (typeof message === "string")
      return logStringMessage(this, "fatal", message, values[0]);
    else if (typeof message === "function")
      this.logLazily("fatal", message);
    else if (!Array.isArray(message))
      this.log("fatal", "{*}", message);
    else
      this.logTemplate("fatal", message, values);
  }
};
var metaLogger = LoggerImpl.getLogger(["logtape", "meta"]);
function isNestedAccess(key) {
  return key.includes(".") || key.includes("[") || key.includes("?.");
}
function getOwnProperty(obj, key) {
  if (key === "__proto__" || key === "prototype" || key === "constructor")
    return;
  if ((typeof obj === "object" || typeof obj === "function") && obj !== null)
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  return;
}
function parseNextSegment(path, fromIndex) {
  const len = path.length;
  let i = fromIndex;
  if (i >= len)
    return null;
  let segment;
  if (path[i] === "[") {
    i++;
    if (i >= len)
      return null;
    if (path[i] === '"' || path[i] === "'") {
      const quote = path[i];
      i++;
      let segmentStr = "";
      while (i < len && path[i] !== quote)
        if (path[i] === "\\") {
          i++;
          if (i < len) {
            const escapeChar = path[i];
            switch (escapeChar) {
              case "n":
                segmentStr += `
`;
                break;
              case "t":
                segmentStr += "\t";
                break;
              case "r":
                segmentStr += "\r";
                break;
              case "b":
                segmentStr += "\b";
                break;
              case "f":
                segmentStr += "\f";
                break;
              case "v":
                segmentStr += "\v";
                break;
              case "0":
                segmentStr += "\x00";
                break;
              case "\\":
                segmentStr += "\\";
                break;
              case '"':
                segmentStr += '"';
                break;
              case "'":
                segmentStr += "'";
                break;
              case "u":
                if (i + 4 < len) {
                  const hex = path.slice(i + 1, i + 5);
                  const codePoint = Number.parseInt(hex, 16);
                  if (!Number.isNaN(codePoint)) {
                    segmentStr += String.fromCharCode(codePoint);
                    i += 4;
                  } else
                    segmentStr += escapeChar;
                } else
                  segmentStr += escapeChar;
                break;
              default:
                segmentStr += escapeChar;
            }
            i++;
          }
        } else {
          segmentStr += path[i];
          i++;
        }
      if (i >= len)
        return null;
      segment = segmentStr;
      i++;
    } else {
      const startIndex = i;
      while (i < len && path[i] !== "]" && path[i] !== "'" && path[i] !== '"')
        i++;
      if (i >= len)
        return null;
      const indexStr = path.slice(startIndex, i);
      if (indexStr.length === 0)
        return null;
      const indexNum = Number(indexStr);
      segment = Number.isNaN(indexNum) ? indexStr : indexNum;
    }
    while (i < len && path[i] !== "]")
      i++;
    if (i < len)
      i++;
  } else {
    const startIndex = i;
    while (i < len && path[i] !== "." && path[i] !== "[" && path[i] !== "?" && path[i] !== "]")
      i++;
    segment = path.slice(startIndex, i);
    if (segment.length === 0)
      return null;
  }
  if (i < len && path[i] === ".")
    i++;
  return {
    segment,
    nextIndex: i
  };
}
function accessProperty(obj, segment) {
  if (typeof segment === "string")
    return getOwnProperty(obj, segment);
  if (Array.isArray(obj) && segment >= 0 && segment < obj.length)
    return obj[segment];
  return;
}
function resolvePropertyPath(obj, path) {
  if (obj == null)
    return;
  if (path.length === 0 || path.endsWith("."))
    return;
  let current = obj;
  let i = 0;
  const len = path.length;
  while (i < len) {
    const isOptional = path.slice(i, i + 2) === "?.";
    if (isOptional) {
      i += 2;
      if (current == null)
        return;
    } else if (current == null)
      return;
    const result = parseNextSegment(path, i);
    if (result === null)
      return;
    const { segment, nextIndex } = result;
    i = nextIndex;
    current = accessProperty(current, segment);
    if (current === undefined)
      return;
  }
  return current;
}
function parseMessageTemplate(template, properties) {
  const length = template.length;
  if (length === 0)
    return [""];
  if (!template.includes("{"))
    return [template];
  const message = [];
  let startIndex = 0;
  for (let i = 0;i < length; i++) {
    const char = template[i];
    if (char === "{") {
      const nextChar = i + 1 < length ? template[i + 1] : "";
      if (nextChar === "{") {
        i++;
        continue;
      }
      const closeIndex = template.indexOf("}", i + 1);
      if (closeIndex === -1)
        continue;
      const beforeText = template.slice(startIndex, i);
      message.push(beforeText.replace(/{{/g, "{").replace(/}}/g, "}"));
      const key = template.slice(i + 1, closeIndex);
      let prop;
      const trimmedKey = key.trim();
      if (trimmedKey === "*")
        prop = key in properties ? properties[key] : ("*" in properties) ? properties["*"] : properties;
      else {
        if (key !== trimmedKey)
          prop = key in properties ? properties[key] : properties[trimmedKey];
        else
          prop = properties[key];
        if (prop === undefined && isNestedAccess(trimmedKey))
          prop = resolvePropertyPath(properties, trimmedKey);
      }
      message.push(prop);
      i = closeIndex;
      startIndex = i + 1;
    } else if (char === "}" && i + 1 < length && template[i + 1] === "}")
      i++;
  }
  const remainingText = template.slice(startIndex);
  message.push(remainingText.replace(/{{/g, "{").replace(/}}/g, "}"));
  return message;
}
function renderMessage(template, values) {
  const args = [];
  for (let i = 0;i < template.length; i++) {
    args.push(template[i]);
    if (i < values.length)
      args.push(values[i]);
  }
  return args;
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/util.node.js
var exports_util_node = {};
__export(exports_util_node, {
  inspect: () => inspect
});
import util from "util";
function inspect(obj, options) {
  return util.inspect(obj, options);
}

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/formatter.js
var levelAbbreviations = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warning: "WRN",
  error: "ERR",
  fatal: "FTL"
};
var platformInspect = typeof document !== "undefined" || typeof navigator !== "undefined" && navigator.product === "ReactNative" ? (v) => JSON.stringify(v) : ("Deno" in globalThis) && ("inspect" in globalThis.Deno) && typeof globalThis.Deno.inspect === "function" ? (v, opts) => globalThis.Deno.inspect(v, {
  strAbbreviateSize: Infinity,
  iterableLimit: Infinity,
  ...opts
}) : exports_util_node != null && ("inspect" in exports_util_node) && typeof inspect === "function" ? (v, opts) => inspect(v, {
  maxArrayLength: Infinity,
  maxStringLength: Infinity,
  ...opts
}) : (v) => JSON.stringify(v);
var inspect2 = (value, options) => String(platformInspect(value, options));
var utf8Encoder = new TextEncoder;
function renderMessageParts(msgParts, valueRenderer) {
  const msgLen = msgParts.length;
  if (msgLen === 1)
    return msgParts[0];
  if (msgLen <= 6) {
    let message = "";
    for (let i = 0;i < msgLen; i++)
      message += i % 2 === 0 ? msgParts[i] : valueRenderer(msgParts[i]);
    return message;
  }
  const parts = new Array(msgLen);
  for (let i = 0;i < msgLen; i++)
    parts[i] = i % 2 === 0 ? msgParts[i] : valueRenderer(msgParts[i]);
  return parts.join("");
}
function padZero(num) {
  return num < 10 ? `0${num}` : `${num}`;
}
function padThree(num) {
  return num < 10 ? `00${num}` : num < 100 ? `0${num}` : `${num}`;
}
var fixedOffsetPattern = /^([+-])(0\d|1\d|2[0-3]):([0-5]\d)$/;
function formatOffset(minutes, full) {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hour = padZero(Math.floor(absolute / 60));
  const minute = padZero(absolute % 60);
  if (!full && minute === "00")
    return `${sign}${hour}`;
  return `${sign}${hour}:${minute}`;
}
function readPartsFromFormatter(formatter, ts) {
  const parts = formatter.formatToParts(new Date(ts));
  let year = "";
  let month = "";
  let day = "";
  let hour = "";
  let minute = "";
  let second = "";
  for (const part of parts)
    if (part.type === "year")
      year = part.value;
    else if (part.type === "month")
      month = part.value;
    else if (part.type === "day")
      day = part.value;
    else if (part.type === "hour")
      hour = part.value;
    else if (part.type === "minute")
      minute = part.value;
    else if (part.type === "second")
      second = part.value;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second
  };
}
function getDateParts(ts, config) {
  const d = new Date(ts);
  const ms = padThree(d.getUTCMilliseconds());
  if (config.kind === "utc")
    return {
      year: `${d.getUTCFullYear()}`,
      month: padZero(d.getUTCMonth() + 1),
      day: padZero(d.getUTCDate()),
      hour: padZero(d.getUTCHours()),
      minute: padZero(d.getUTCMinutes()),
      second: padZero(d.getUTCSeconds()),
      ms,
      offsetMinutes: 0
    };
  if (config.kind === "local")
    return {
      year: `${d.getFullYear()}`,
      month: padZero(d.getMonth() + 1),
      day: padZero(d.getDate()),
      hour: padZero(d.getHours()),
      minute: padZero(d.getMinutes()),
      second: padZero(d.getSeconds()),
      ms,
      offsetMinutes: -d.getTimezoneOffset()
    };
  if (config.kind === "offset") {
    const shifted = new Date(ts + config.minutes * 60000);
    return {
      year: `${shifted.getUTCFullYear()}`,
      month: padZero(shifted.getUTCMonth() + 1),
      day: padZero(shifted.getUTCDate()),
      hour: padZero(shifted.getUTCHours()),
      minute: padZero(shifted.getUTCMinutes()),
      second: padZero(shifted.getUTCSeconds()),
      ms,
      offsetMinutes: config.minutes
    };
  }
  const parts = readPartsFromFormatter(config.formatter, ts);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), d.getUTCMilliseconds());
  const offsetMinutes = Math.round((asUtc - ts) / 60000);
  return {
    ...parts,
    ms,
    offsetMinutes
  };
}
function resolveTimeZone(timeZone) {
  if (typeof timeZone === "undefined")
    return { kind: "utc" };
  if (timeZone === null)
    return { kind: "local" };
  const offsetMatch = fixedOffsetPattern.exec(timeZone);
  if (offsetMatch != null) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3]);
    return {
      kind: "offset",
      minutes: sign * (hours * 60 + minutes)
    };
  }
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function")
    throw new TypeError(`Invalid timeZone option: ${JSON.stringify(timeZone)}. This environment does not support IANA time zones.`);
  try {
    return {
      kind: "iana",
      formatter: new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hour12: false,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    };
  } catch {
    throw new TypeError(`Invalid timeZone option: ${JSON.stringify(timeZone)}. Expected an IANA time zone name (e.g., "Asia/Seoul") or a fixed UTC offset string (e.g., "+09:00").`);
  }
}
function createTimestampFormatter(pattern, timeZone) {
  if (pattern === "none")
    return () => null;
  if (pattern === "rfc3339" && timeZone.kind === "utc")
    return (ts) => new Date(ts).toISOString();
  return (ts) => {
    const parts = getDateParts(ts, timeZone);
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}:${parts.second}.${parts.ms}`;
    const tzLong = formatOffset(parts.offsetMinutes, true);
    const tzShort = formatOffset(parts.offsetMinutes, false);
    if (pattern === "date-time-timezone")
      return `${date} ${time} ${tzLong}`;
    if (pattern === "date-time-tz")
      return `${date} ${time} ${tzShort}`;
    if (pattern === "date-time")
      return `${date} ${time}`;
    if (pattern === "time-timezone")
      return `${time} ${tzLong}`;
    if (pattern === "time-tz")
      return `${time} ${tzShort}`;
    if (pattern === "time")
      return time;
    if (pattern === "date")
      return date;
    return `${date}T${time}${tzLong}`;
  };
}
var levelRenderersCache = {
  ABBR: levelAbbreviations,
  abbr: {
    trace: "trc",
    debug: "dbg",
    info: "inf",
    warning: "wrn",
    error: "err",
    fatal: "ftl"
  },
  FULL: {
    trace: "TRACE",
    debug: "DEBUG",
    info: "INFO",
    warning: "WARNING",
    error: "ERROR",
    fatal: "FATAL"
  },
  full: {
    trace: "trace",
    debug: "debug",
    info: "info",
    warning: "warning",
    error: "error",
    fatal: "fatal"
  },
  L: {
    trace: "T",
    debug: "D",
    info: "I",
    warning: "W",
    error: "E",
    fatal: "F"
  },
  l: {
    trace: "t",
    debug: "d",
    info: "i",
    warning: "w",
    error: "e",
    fatal: "f"
  }
};
function getLineEndingValue(lineEnding) {
  return lineEnding === "crlf" ? `\r
` : `
`;
}
function jsonReplacer(_key, value) {
  if (!(value instanceof Error))
    return value;
  const serialized = {
    name: value.name,
    message: value.message
  };
  if (typeof value.stack === "string")
    serialized.stack = value.stack;
  const cause = value.cause;
  if (cause !== undefined)
    serialized.cause = cause;
  if (typeof AggregateError !== "undefined" && value instanceof AggregateError)
    serialized.errors = value.errors;
  for (const key of Object.keys(value))
    if (!(key in serialized))
      serialized[key] = value[key];
  return serialized;
}
function renderDefaultJsonLinesMessage(message) {
  const messageLength = message.length;
  if (messageLength === 1)
    return message[0];
  if (messageLength === 3)
    return message[0] + JSON.stringify(message[1]) + message[2];
  let rendered = message[0];
  for (let i = 1;i < messageLength; i++)
    rendered += i & 1 ? JSON.stringify(message[i]) : message[i];
  return rendered;
}
function stringifyJsonLinesField(key, value) {
  if (value != null && (typeof value === "object" || typeof value === "function" || typeof value === "bigint")) {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function")
      value = toJSON.call(value, key);
  }
  return JSON.stringify(jsonReplacer(key, value), jsonReplacer);
}
function formatDefaultJsonLinesRecord(record, lineEnding) {
  const level = record.level === "warning" ? "WARN" : record.level.toUpperCase();
  const messageJson = stringifyJsonLinesField("message", renderDefaultJsonLinesMessage(record.message));
  const propertiesJson = stringifyJsonLinesField("properties", record.properties);
  let line = `{"@timestamp":${JSON.stringify(new Date(record.timestamp).toISOString())},"level":${JSON.stringify(level)}`;
  if (messageJson !== undefined)
    line += `,"message":${messageJson}`;
  line += `,"logger":${JSON.stringify(record.category.join("."))}`;
  if (propertiesJson !== undefined)
    line += `,"properties":${propertiesJson}`;
  return `${line}}${lineEnding}`;
}
function getTextFormatter(options = {}) {
  const timestampRenderer = (() => {
    const tsOption = options.timestamp;
    const timeZone = resolveTimeZone(options.timeZone);
    if (tsOption == null)
      return createTimestampFormatter("date-time-timezone", timeZone);
    else if (tsOption === "disabled")
      return createTimestampFormatter("none", timeZone);
    else if (typeof tsOption === "string" && (tsOption === "date-time-timezone" || tsOption === "date-time-tz" || tsOption === "date-time" || tsOption === "time-timezone" || tsOption === "time-tz" || tsOption === "time" || tsOption === "date" || tsOption === "rfc3339" || tsOption === "none"))
      return createTimestampFormatter(tsOption, timeZone);
    else
      return tsOption;
  })();
  const categorySeparator = options.category ?? "\xB7";
  const valueRenderer = options.value ? (v) => options.value(v, inspect2) : inspect2;
  const levelRenderer = (() => {
    const levelOption = options.level;
    if (levelOption == null || levelOption === "ABBR")
      return (level) => levelRenderersCache.ABBR[level];
    else if (levelOption === "abbr")
      return (level) => levelRenderersCache.abbr[level];
    else if (levelOption === "FULL")
      return (level) => levelRenderersCache.FULL[level];
    else if (levelOption === "full")
      return (level) => levelRenderersCache.full[level];
    else if (levelOption === "L")
      return (level) => levelRenderersCache.L[level];
    else if (levelOption === "l")
      return (level) => levelRenderersCache.l[level];
    else
      return levelOption;
  })();
  const lineEnding = getLineEndingValue(options.lineEnding);
  const formatter = options.format ?? (({ timestamp, level, category, message }) => `${timestamp ? `${timestamp} ` : ""}[${level}] ${category}: ${message}`);
  return (record) => {
    const message = renderMessageParts(record.message, valueRenderer);
    const timestamp = timestampRenderer(record.timestamp);
    const level = levelRenderer(record.level);
    const category = typeof categorySeparator === "function" ? categorySeparator(record.category) : record.category.join(categorySeparator);
    const values = {
      timestamp,
      level,
      category,
      message,
      record
    };
    return `${formatter(values)}${lineEnding}`;
  };
}
var defaultTextFormatter = getTextFormatter();
var RESET = "\x1B[0m";
var ansiColors = {
  black: "\x1B[30m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  magenta: "\x1B[35m",
  cyan: "\x1B[36m",
  white: "\x1B[37m"
};
var ansiStyles = {
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  italic: "\x1B[3m",
  underline: "\x1B[4m",
  strikethrough: "\x1B[9m"
};
var defaultLevelColors = {
  trace: null,
  debug: "blue",
  info: "green",
  warning: "yellow",
  error: "red",
  fatal: "magenta"
};
function getAnsiColorFormatter(options = {}) {
  const format = options.format;
  const timestampStyle = typeof options.timestampStyle === "undefined" ? "dim" : options.timestampStyle;
  const timestampColor = options.timestampColor ?? null;
  const timestampPrefix = `${timestampStyle == null ? "" : ansiStyles[timestampStyle]}${timestampColor == null ? "" : ansiColors[timestampColor]}`;
  const timestampSuffix = timestampStyle == null && timestampColor == null ? "" : RESET;
  const levelStyle = typeof options.levelStyle === "undefined" ? "bold" : options.levelStyle;
  const levelColors = options.levelColors ?? defaultLevelColors;
  const categoryStyle = typeof options.categoryStyle === "undefined" ? "dim" : options.categoryStyle;
  const categoryColor = options.categoryColor ?? null;
  const categoryPrefix = `${categoryStyle == null ? "" : ansiStyles[categoryStyle]}${categoryColor == null ? "" : ansiColors[categoryColor]}`;
  const categorySuffix = categoryStyle == null && categoryColor == null ? "" : RESET;
  return getTextFormatter({
    timestamp: "date-time-tz",
    value(value, fallbackInspect) {
      return fallbackInspect(value, { colors: true });
    },
    ...options,
    format({ timestamp, level, category, message, record }) {
      const levelColor = levelColors[record.level];
      timestamp = timestamp == null ? null : `${timestampPrefix}${timestamp}${timestampSuffix}`;
      level = `${levelStyle == null ? "" : ansiStyles[levelStyle]}${levelColor == null ? "" : ansiColors[levelColor]}${level}${levelStyle == null && levelColor == null ? "" : RESET}`;
      return format == null ? `${timestamp == null ? "" : `${timestamp} `}${level} ${categoryPrefix}${category}:${categorySuffix} ${message}` : format({
        timestamp,
        level,
        category: `${categoryPrefix}${category}${categorySuffix}`,
        message,
        record
      });
    }
  });
}
var ansiColorFormatter = getAnsiColorFormatter();
function getJsonLinesFormatter(options = {}) {
  const lineEnding = getLineEndingValue(options.lineEnding);
  if (!options.categorySeparator && !options.message && !options.properties)
    return (record) => formatDefaultJsonLinesRecord(record, lineEnding);
  const isTemplateMessage = options.message === "template";
  const propertiesOption = options.properties ?? "nest:properties";
  let joinCategory;
  if (typeof options.categorySeparator === "function")
    joinCategory = options.categorySeparator;
  else {
    const separator = options.categorySeparator ?? ".";
    joinCategory = (category) => category.join(separator);
  }
  let getProperties;
  if (propertiesOption === "flatten")
    getProperties = (properties) => properties;
  else if (propertiesOption.startsWith("prepend:")) {
    const prefix = propertiesOption.substring(8);
    if (prefix === "")
      throw new TypeError(`Invalid properties option: ${JSON.stringify(propertiesOption)}. It must be of the form "prepend:<prefix>" where <prefix> is a non-empty string.`);
    getProperties = (properties) => {
      const result = {};
      for (const key in properties)
        result[`${prefix}${key}`] = properties[key];
      return result;
    };
  } else if (propertiesOption.startsWith("nest:")) {
    const key = propertiesOption.substring(5);
    getProperties = (properties) => ({ [key]: properties });
  } else
    throw new TypeError(`Invalid properties option: ${JSON.stringify(propertiesOption)}. It must be "flatten", "prepend:<prefix>", or "nest:<key>".`);
  let getMessage;
  if (isTemplateMessage)
    getMessage = (record) => {
      if (typeof record.rawMessage === "string")
        return record.rawMessage;
      let msg = "";
      for (let i = 0;i < record.rawMessage.length; i++) {
        if (i > 0)
          msg += "{}";
        msg += record.rawMessage[i];
      }
      return msg;
    };
  else
    getMessage = (record) => {
      const msgLen = record.message.length;
      if (msgLen === 1)
        return record.message[0];
      let msg = "";
      for (let i = 0;i < msgLen; i++)
        msg += i % 2 < 1 ? record.message[i] : JSON.stringify(record.message[i]);
      return msg;
    };
  return (record) => {
    return JSON.stringify({
      "@timestamp": new Date(record.timestamp).toISOString(),
      level: record.level === "warning" ? "WARN" : record.level.toUpperCase(),
      message: getMessage(record),
      logger: joinCategory(record.category),
      ...getProperties(record.properties)
    }, jsonReplacer) + lineEnding;
  };
}
var jsonLinesFormatter = getJsonLinesFormatter();
function renderStructuredMessage(record, template) {
  if (template) {
    if (typeof record.rawMessage === "string")
      return record.rawMessage;
    return record.rawMessage.join("{}");
  }
  return renderMessageParts(record.message, stringifyLogfmtValue);
}
function filterLogfmtKey(key) {
  if (key === "")
    return null;
  let needsEscape = false;
  for (const char of key) {
    const code = char.codePointAt(0);
    if (shouldEscapeLogfmtKeyChar(char, code)) {
      needsEscape = true;
      break;
    }
  }
  if (!needsEscape)
    return key;
  let result = "";
  for (const char of key) {
    const code = char.codePointAt(0);
    if (shouldEscapeLogfmtKeyChar(char, code))
      result += encodeLogfmtKeyChar(char);
    else
      result += char;
  }
  return result;
}
function shouldEscapeLogfmtKeyChar(char, code) {
  return code <= 32 || code === 127 || code === 65533 || char === "=" || char === '"' || char === "%";
}
function encodeLogfmtKeyChar(char) {
  let result = "";
  for (const byte of utf8Encoder.encode(char))
    result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return result;
}
function stringifyLogfmtValue(value) {
  if (typeof value === "string")
    return value;
  if (value === null)
    return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "undefined" || typeof value === "symbol" || typeof value === "function")
    return String(value);
  try {
    const json = JSON.stringify(value, jsonReplacer);
    if (typeof json === "string")
      return unwrapJsonStringLiteral(json);
  } catch {}
  return inspect2(value, { colors: false });
}
function unwrapJsonStringLiteral(json) {
  if (json.startsWith('"') && json.endsWith('"'))
    return JSON.parse(json);
  return json;
}
function quoteLogfmtValue(value, isString) {
  let needsQuote = value === "" || isString && shouldQuoteStringLiteral(value);
  for (const char of value) {
    const code = char.codePointAt(0);
    if (shouldQuoteLogfmtValueChar(char, code)) {
      needsQuote = true;
      break;
    }
  }
  if (!needsQuote)
    return value;
  let quoted = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    quoted += escapeLogfmtValueChar(char, code);
  }
  return `"${quoted}"`;
}
function shouldQuoteStringLiteral(value) {
  return value === "null" || value === "undefined" || value === "true" || value === "false";
}
function shouldQuoteLogfmtValueChar(char, code) {
  return code <= 32 || code === 127 || code === 65533 || char === "=" || char === '"' || char === "\\";
}
function escapeLogfmtValueChar(char, code) {
  switch (char) {
    case "\t":
      return "\\t";
    case `
`:
      return "\\n";
    case "\r":
      return "\\r";
    case '"':
      return "\\\"";
    case "\\":
      return "\\\\";
    default:
      return code <= 31 || code === 127 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
}
function formatLogfmtValue(value) {
  const stringified = stringifyLogfmtValue(value);
  return quoteLogfmtValue(stringified, typeof value === "string");
}
function pushLogfmtPair(pairs, key, value) {
  const filteredKey = filterLogfmtKey(key);
  if (filteredKey == null)
    return;
  pairs.push(`${filteredKey}=${formatLogfmtValue(value)}`);
}
function getLogfmtFormatter(options = {}) {
  const prependPrefix = "prepend:";
  const lineEnding = getLineEndingValue(options.lineEnding);
  const timestampRenderer = createTimestampFormatter("rfc3339", resolveTimeZone(options.timeZone));
  const isTemplateMessage = options.message === "template";
  const propertiesOption = options.properties ?? "flatten";
  let joinCategory;
  if (typeof options.categorySeparator === "function")
    joinCategory = options.categorySeparator;
  else {
    const separator = options.categorySeparator ?? ".";
    joinCategory = (category) => category.join(separator);
  }
  let propertyPrefix = "";
  if (propertiesOption === "flatten")
    propertyPrefix = "";
  else if (propertiesOption.startsWith(prependPrefix)) {
    propertyPrefix = propertiesOption.substring(prependPrefix.length);
    if (propertyPrefix === "")
      throw new TypeError("Invalid properties option: " + JSON.stringify(propertiesOption) + '. It must be of the form "prepend:<prefix>" where <prefix> is a non-empty string.');
  } else
    throw new TypeError(`Invalid properties option: ${JSON.stringify(propertiesOption)}. It must be "flatten" or "prepend:<prefix>".`);
  return (record) => {
    const pairs = [];
    pushLogfmtPair(pairs, "time", timestampRenderer(record.timestamp));
    pushLogfmtPair(pairs, "level", record.level);
    pushLogfmtPair(pairs, "logger", joinCategory(record.category));
    pushLogfmtPair(pairs, "msg", renderStructuredMessage(record, isTemplateMessage));
    for (const key in record.properties)
      if (Object.prototype.hasOwnProperty.call(record.properties, key))
        pushLogfmtPair(pairs, `${propertyPrefix}${key}`, record.properties[key]);
    return `${pairs.join(" ")}${lineEnding}`;
  };
}
var logfmtFormatter = getLogfmtFormatter();
var logLevelStyles = {
  trace: "background-color: gray; color: white;",
  debug: "background-color: gray; color: white;",
  info: "background-color: white; color: black;",
  warning: "background-color: orange; color: black;",
  error: "background-color: red; color: white;",
  fatal: "background-color: maroon; color: white;"
};
function defaultConsoleFormatter(record) {
  let msg = "";
  const values = [];
  for (let i = 0;i < record.message.length; i++)
    if (i % 2 === 0)
      msg += record.message[i];
    else {
      msg += "%o";
      values.push(record.message[i]);
    }
  const date = new Date(record.timestamp);
  const time = `${date.getUTCHours().toString().padStart(2, "0")}:${date.getUTCMinutes().toString().padStart(2, "0")}:${date.getUTCSeconds().toString().padStart(2, "0")}.${date.getUTCMilliseconds().toString().padStart(3, "0")}`;
  return [
    `%c${time} %c${levelAbbreviations[record.level]}%c %c${record.category.join("\xB7")} %c${msg}`,
    "color: gray;",
    logLevelStyles[record.level],
    "background-color: default;",
    "color: gray;",
    "color: default;",
    ...values
  ];
}
// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/sink.js
var immediateSinkSymbol2 = Symbol.for("LogTape.sinkSnapshotPolicy.immediate");
function getConsoleSink(options = {}) {
  const formatter = options.formatter ?? defaultConsoleFormatter;
  const levelMap = {
    trace: "debug",
    debug: "debug",
    info: "info",
    warning: "warn",
    error: "error",
    fatal: "error",
    ...options.levelMap ?? {}
  };
  const console = options.console ?? globalThis.console;
  const baseSink = (record) => {
    const args = formatter(record);
    const method = levelMap[record.level];
    if (method === undefined)
      throw new TypeError(`Invalid log level: ${record.level}.`);
    if (typeof args === "string") {
      const msg = args.replace(/\r?\n$/, "");
      console[method](msg);
    } else
      console[method](...args);
  };
  if (!options.nonBlocking)
    return baseSink;
  const nonBlockingConfig = options.nonBlocking === true ? {} : options.nonBlocking;
  const bufferSize = nonBlockingConfig.bufferSize ?? 100;
  const flushInterval = nonBlockingConfig.flushInterval ?? 100;
  const buffer = [];
  let flushTimer = null;
  let scheduledFlushTimer = null;
  let disposed = false;
  let flushScheduled = false;
  const maxBufferSize = bufferSize * 2;
  function flush() {
    if (buffer.length === 0)
      return;
    const records = buffer.splice(0);
    for (const record of records)
      try {
        baseSink(record);
      } catch {}
  }
  function scheduleFlush() {
    if (flushScheduled)
      return;
    flushScheduled = true;
    scheduledFlushTimer = setTimeout(() => {
      scheduledFlushTimer = null;
      flushScheduled = false;
      flush();
    }, 0);
  }
  function startFlushTimer() {
    if (flushTimer !== null || disposed)
      return;
    flushTimer = setInterval(() => {
      flush();
    }, flushInterval);
  }
  const nonBlockingSink = (record) => {
    if (disposed)
      return;
    if (buffer.length >= maxBufferSize)
      buffer.shift();
    buffer.push(record);
    if (buffer.length >= bufferSize)
      scheduleFlush();
    else if (flushTimer === null)
      startFlushTimer();
  };
  nonBlockingSink[Symbol.dispose] = () => {
    disposed = true;
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (scheduledFlushTimer !== null) {
      clearTimeout(scheduledFlushTimer);
      scheduledFlushTimer = null;
      flushScheduled = false;
    }
    flush();
  };
  return nonBlockingSink;
}
var _asyncSinkError = Symbol.for("logtape.asyncSinkError");

// node_modules/.bun/@logtape+logtape@2.3.1/node_modules/@logtape/logtape/dist/config.js
var currentConfig = null;
var activeScopedConfigCount = 0;
var activeScopedConfigs = /* @__PURE__ */ new Set;
var globalConfigMutationInProgress = false;
var strongRefs = /* @__PURE__ */ new Set;
var filterDisposables = /* @__PURE__ */ new Set;
var sinkDisposables = /* @__PURE__ */ new Set;
var asyncFilterDisposables = /* @__PURE__ */ new Set;
var asyncSinkDisposables = /* @__PURE__ */ new Set;
var unregisterDisposeHook;
function isLoggerConfigMeta(cfg) {
  const category = Array.isArray(cfg.category) ? cfg.category : [cfg.category];
  return category.length === 0 || category.length === 1 && category[0] === "logtape" || category.length === 2 && category[0] === "logtape" && category[1] === "meta";
}
function registerDisposeHook(allowAsync) {
  unregisterDisposeHook?.();
  unregisterDisposeHook = undefined;
  const handler = allowAsync ? disposeInternal : disposeSyncInternal;
  if (typeof globalThis.EdgeRuntime !== "string" && "process" in globalThis && !("Deno" in globalThis)) {
    const proc = globalThis.process;
    const onMethod = proc?.["on"];
    if (typeof onMethod === "function") {
      onMethod.call(proc, "exit", handler);
      unregisterDisposeHook = () => {
        const offMethod = proc?.["off"] ?? proc?.["removeListener"];
        if (typeof offMethod === "function")
          offMethod.call(proc, "exit", handler);
      };
      return;
    }
  }
  const addEventListenerMethod = globalThis.addEventListener;
  if (typeof addEventListenerMethod !== "function")
    return;
  const removeEventListenerMethod = globalThis.removeEventListener;
  if ("Deno" in globalThis) {
    addEventListenerMethod.call(globalThis, "unload", handler);
    if (typeof removeEventListenerMethod === "function")
      unregisterDisposeHook = () => {
        removeEventListenerMethod.call(globalThis, "unload", handler);
      };
  } else {
    addEventListenerMethod.call(globalThis, "pagehide", handler);
    if (typeof removeEventListenerMethod === "function")
      unregisterDisposeHook = () => {
        removeEventListenerMethod.call(globalThis, "pagehide", handler);
      };
  }
}
function configureSync(config) {
  runGlobalConfigMutationSync("configureSync()", () => {
    if (currentConfig != null && !config.reset)
      throw new ConfigError("Already configured; if you want to reset, turn on the reset flag.");
    if (asyncFilterDisposables.size > 0 || asyncSinkDisposables.size > 0)
      throw new ConfigError("Previously configured async disposables are still active. Use configure() instead or explicitly dispose them using dispose().");
    disposeSyncInternal();
    resetInternal();
    try {
      configureInternal(config, false);
    } catch (e) {
      if (e instanceof ConfigError) {
        disposeSyncInternal();
        resetInternal();
      }
      throw e;
    }
  });
}
function withConfigSync(config, callback) {
  const contextLocalStorage = getConfiguredContextLocalStorage("withConfigSync()");
  const scopedConfig = compileScopedConfig(config, false, (message) => new ConfigError(message));
  let result;
  let callbackError;
  let callbackFailed = false;
  activeScopedConfigCount++;
  activeScopedConfigs.add(scopedConfig);
  try {
    result = runWithScopedConfig(contextLocalStorage, scopedConfig, callback);
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {});
      callbackFailed = true;
      callbackError = new ConfigError("withConfigSync() callback must not return a promise. Use withConfig() for async callbacks.");
    }
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  try {
    disposeScopedConfigSync(scopedConfig, getRetainedDisposables(scopedConfig));
  } catch (disposeError) {
    if (callbackFailed)
      throwCombinedErrors(callbackError, disposeError);
    throw disposeError;
  } finally {
    activeScopedConfigs.delete(scopedConfig);
    activeScopedConfigCount--;
  }
  if (callbackFailed)
    throw callbackError;
  return result;
}
function isThenable(value) {
  return value != null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function";
}
function getGlobalDisposables() {
  return new Set([
    ...filterDisposables,
    ...asyncFilterDisposables,
    ...sinkDisposables,
    ...asyncSinkDisposables
  ]);
}
function getRetainedDisposables(scopedConfig) {
  const disposables = new Set(getGlobalDisposables());
  for (const activeScopedConfig of activeScopedConfigs) {
    if (activeScopedConfig === scopedConfig || activeScopedConfig.disposed)
      continue;
    addScopedConfigDisposables(disposables, activeScopedConfig);
  }
  return disposables;
}
function addScopedConfigDisposables(disposables, scopedConfig) {
  for (const disposable of scopedConfig.syncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncFilters)
    disposables.add(disposable);
  for (const disposable of scopedConfig.syncSinks)
    disposables.add(disposable);
  for (const disposable of scopedConfig.asyncSinks)
    disposables.add(disposable);
}
function configureInternal(config, allowAsync) {
  currentConfig = config;
  let metaConfigured = false;
  const configuredCategories = /* @__PURE__ */ new Set;
  for (const cfg of config.loggers) {
    if (isLoggerConfigMeta(cfg))
      metaConfigured = true;
    const categoryKey2 = Array.isArray(cfg.category) ? JSON.stringify(cfg.category) : JSON.stringify([cfg.category]);
    if (configuredCategories.has(categoryKey2))
      throw new ConfigError(`Duplicate logger configuration for category: ${categoryKey2}. Each category can only be configured once.`);
    configuredCategories.add(categoryKey2);
    const logger = LoggerImpl.getLogger(cfg.category);
    for (const sinkId of cfg.sinks ?? []) {
      const sink = config.sinks[sinkId];
      if (!sink)
        throw new ConfigError(`Sink not found: ${sinkId}.`);
      logger.sinks.push(sink);
    }
    logger.parentSinks = cfg.parentSinks ?? "inherit";
    if (cfg.lowestLevel !== undefined)
      logger.lowestLevel = cfg.lowestLevel;
    for (const filterId of cfg.filters ?? []) {
      const filter = config.filters?.[filterId];
      if (filter === undefined)
        throw new ConfigError(`Filter not found: ${filterId}.`);
      logger.filters.push(toFilter(filter));
    }
    strongRefs.add(logger);
  }
  LoggerImpl.getLogger().contextLocalStorage = config.contextLocalStorage;
  for (const sink of Object.values(config.sinks)) {
    if (Symbol.asyncDispose in sink)
      if (allowAsync)
        asyncSinkDisposables.add(sink);
      else
        throw new ConfigError("Async disposables cannot be used with configureSync().");
    if (Symbol.dispose in sink)
      sinkDisposables.add(sink);
  }
  for (const filter of Object.values(config.filters ?? {})) {
    if (filter == null || typeof filter === "string")
      continue;
    if (Symbol.asyncDispose in filter) {
      if (allowAsync)
        asyncFilterDisposables.add(filter);
      else
        throw new ConfigError("Async disposables cannot be used with configureSync().");
      asyncSinkDisposables.delete(filter);
    }
    if (Symbol.dispose in filter) {
      filterDisposables.add(filter);
      sinkDisposables.delete(filter);
    }
  }
  registerDisposeHook(allowAsync);
  const meta = LoggerImpl.getLogger(["logtape", "meta"]);
  if (!metaConfigured)
    meta.sinks.push(getConsoleSink());
  meta.info("LogTape loggers are configured.  Note that LogTape itself uses the meta logger, which has category {metaLoggerCategory}.  The meta logger is used to log internal diagnostics such as sink exceptions.  It's recommended to configure the meta logger with a separate sink so that you can easily notice if logging itself fails or is misconfigured.  To turn off this message, configure the meta logger with higher log levels than {dismissLevel}.  See also <https://logtape.org/manual/categories#meta-logger>.", {
    metaLoggerCategory: ["logtape", "meta"],
    dismissLevel: "info"
  });
}
function getConfig() {
  return currentConfig;
}
function resetInternal() {
  unregisterDisposeHook?.();
  unregisterDisposeHook = undefined;
  const rootLogger = LoggerImpl.getLogger([]);
  rootLogger.resetDescendants();
  delete rootLogger.contextLocalStorage;
  strongRefs.clear();
  currentConfig = null;
}
async function disposeInternal() {
  const errors = [];
  try {
    disposeSyncFilters();
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeAsyncFilters();
  } catch (error) {
    errors.push(error);
  }
  try {
    disposeSyncSinks();
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeAsyncSinks();
  } catch (error) {
    errors.push(error);
  }
  throwDisposeErrors2(errors);
}
function disposeSyncInternal() {
  const errors = [];
  try {
    disposeSyncFilters();
  } catch (error) {
    errors.push(error);
  }
  try {
    disposeSyncSinks();
  } catch (error) {
    errors.push(error);
  }
  throwDisposeErrors2(errors);
}
function getConfiguredContextLocalStorage(functionName) {
  if (globalConfigMutationInProgress)
    throw new ConfigError(`${functionName} cannot be called while LogTape is being reconfigured.`);
  if (currentConfig == null)
    throw new ConfigError(`${functionName} requires LogTape to be configured first.`);
  const contextLocalStorage = LoggerImpl.getLogger().contextLocalStorage;
  if (contextLocalStorage == null)
    throw new ConfigError(`${functionName} requires Config.contextLocalStorage to be configured.`);
  return contextLocalStorage;
}
function runGlobalConfigMutationSync(functionName, callback) {
  assertCanMutateGlobalConfig(functionName);
  globalConfigMutationInProgress = true;
  try {
    return callback();
  } finally {
    globalConfigMutationInProgress = false;
  }
}
function assertCanMutateGlobalConfig(functionName) {
  if (globalConfigMutationInProgress)
    throw new ConfigError(`${functionName} cannot be called while LogTape is being reconfigured.`);
  assertNoScopedConfig(functionName);
}
function assertNoScopedConfig(functionName) {
  if (activeScopedConfigCount > 0)
    throw new ConfigError(`${functionName} cannot be called while a scoped configuration is active. Use nested withConfig() instead.`);
}
function disposeSyncFilters() {
  disposeSyncDisposables2(filterDisposables);
}
function disposeSyncSinks() {
  disposeSyncDisposables2(sinkDisposables);
}
function disposeSyncDisposables2(disposables) {
  const errors = [];
  try {
    for (const disposable of disposables)
      try {
        disposable[Symbol.dispose]();
      } catch (error) {
        errors.push(error);
      } finally {
        disposables.delete(disposable);
      }
  } finally {
    disposables.clear();
  }
  throwDisposeErrors2(errors);
}
async function disposeAsyncFilters() {
  await disposeAsyncDisposables(asyncFilterDisposables);
}
async function disposeAsyncSinks() {
  await disposeAsyncDisposables(asyncSinkDisposables);
}
async function disposeAsyncDisposables(disposables) {
  const promises = [];
  try {
    for (const disposable of disposables)
      try {
        promises.push(Promise.resolve(disposable[Symbol.asyncDispose]()));
      } catch (error) {
        promises.push(Promise.reject(error));
      } finally {
        disposables.delete(disposable);
      }
  } finally {
    disposables.clear();
  }
  await settleDisposePromises(promises);
}
async function settleDisposePromises(promises) {
  const results = await Promise.allSettled(promises);
  throwDisposeErrors2(results.filter((result) => result.status === "rejected").map((result) => result.reason));
}
function throwDisposeErrors2(errors) {
  if (errors.length < 1)
    return;
  if (errors.length === 1)
    throw errors[0];
  throw new AggregateError(errors, "Multiple errors occurred while disposing LogTape resources.");
}
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};

// node_modules/.bun/@logtape+redaction@2.3.1+455acf1e86969edf/node_modules/@logtape/redaction/dist/traversal.js
var redactionTruncatedValue = "[truncated]";
var defaultMaxDepth = 20;
var defaultMaxProperties = 1000;
function createRedactionTraversalContext(options, reportLimitExceeded, visited = /* @__PURE__ */ new Map) {
  const limits = {
    maxDepth: normalizeLimit(options.maxDepth, defaultMaxDepth),
    maxProperties: normalizeLimit(options.maxProperties, defaultMaxProperties)
  };
  const exceededLimits = /* @__PURE__ */ new Set;
  return {
    limits,
    visited,
    exceededLimits,
    reportLimitExceeded(limit) {
      exceededLimits.add(limit);
      reportLimitExceeded(limit, limits);
    }
  };
}
function normalizeLimit(value, defaultValue) {
  if (value == null)
    return defaultValue;
  if (!Number.isFinite(value) || value < 0)
    return defaultValue;
  return Math.floor(value);
}

// node_modules/.bun/@logtape+redaction@2.3.1+455acf1e86969edf/node_modules/@logtape/redaction/dist/field.js
var metaLogger2 = getLogger(["logtape", "meta"]);
var reportingRedactionLimit = false;
var DEFAULT_REDACT_FIELDS = [
  /pass(?:code|phrase|word)/i,
  /secret/i,
  /token/i,
  /key/i,
  /credential/i,
  /auth/i,
  /signature/i,
  /sensitive/i,
  /private/i,
  /ssn/i,
  /email/i,
  /phone/i,
  /address/i
];
function redactByField(sink, options = DEFAULT_REDACT_FIELDS) {
  const opts = Array.isArray(options) ? { fieldPatterns: options } : options;
  const wrapped = (record) => {
    const context = createFieldRedactionContext(opts);
    const redactedProperties = redactProperties(record.properties, opts, context.visited, 0, context);
    let redactedMessage = record.message;
    if (typeof record.rawMessage === "string") {
      const placeholders = extractPlaceholderNames(record.rawMessage);
      const { redactedIndices, wildcardIndices } = getRedactedPlaceholderIndices(placeholders, opts.fieldPatterns);
      redactedMessage = redactMessageArray(record.message, placeholders, redactedIndices, wildcardIndices, redactedProperties, opts.action, context.exceededLimits.size > 0);
    } else {
      const redactedValues = getRedactedValues(record.properties, redactedProperties);
      if (redactedValues.size > 0 || context.exceededLimits.size > 0)
        redactedMessage = redactMessageByValues(record.message, redactedValues, context.exceededLimits.size > 0);
    }
    sink({
      ...record,
      message: redactedMessage,
      properties: redactedProperties
    });
  };
  if (Symbol.dispose in sink)
    wrapped[Symbol.dispose] = sink[Symbol.dispose];
  if (Symbol.asyncDispose in sink)
    wrapped[Symbol.asyncDispose] = sink[Symbol.asyncDispose];
  return wrapped;
}
function reportRedactionLimitExceeded(limit, limits) {
  if (reportingRedactionLimit || typeof metaLogger2.warn !== "function")
    return;
  try {
    reportingRedactionLimit = true;
    metaLogger2.warn("Redaction traversal exceeded {limit}; replacing or omitting remaining data to keep logging bounded.", {
      limit,
      ...limits
    });
  } catch {} finally {
    reportingRedactionLimit = false;
  }
}
function createFieldRedactionContext(options, visited = /* @__PURE__ */ new Map) {
  return createRedactionTraversalContext(options, reportRedactionLimitExceeded, visited);
}
function reportLimitOnce(context, limit) {
  if (context.exceededLimits.has(limit))
    return;
  context.reportLimitExceeded(limit);
}
function redactProperties(properties, options, visited = /* @__PURE__ */ new Map, depth = 0, context = createFieldRedactionContext(options, visited)) {
  if (visited.has(properties))
    return visited.get(properties);
  const copy = {};
  visited.set(properties, copy);
  const fields = Object.keys(properties);
  if (fields.length > context.limits.maxProperties)
    reportLimitOnce(context, "maxProperties");
  for (const field of fields.slice(0, context.limits.maxProperties)) {
    if (shouldFieldRedacted(field, options.fieldPatterns)) {
      if (typeof options.action === "function")
        setProperty(copy, field, options.action(properties[field]));
      continue;
    }
    const value = properties[field];
    if (Array.isArray(value))
      if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        setProperty(copy, field, redactionTruncatedValue);
      } else
        setProperty(copy, field, redactArray(value, options, visited, depth + 1, context));
    else if (typeof value === "object" && value !== null)
      if (isBuiltInObject(value))
        setProperty(copy, field, value);
      else if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        setProperty(copy, field, redactionTruncatedValue);
      } else
        setProperty(copy, field, redactProperties(value, options, visited, depth + 1, context));
    else
      setProperty(copy, field, value);
  }
  return copy;
}
function setProperty(object, field, value) {
  if (field === "__proto__")
    Object.defineProperty(object, field, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  else
    object[field] = value;
}
function redactArray(array, options, visited, depth, context) {
  if (visited.has(array))
    return visited.get(array);
  const copy = [];
  const length = Math.min(array.length, context.limits.maxProperties);
  copy.length = length;
  visited.set(array, copy);
  if (array.length > context.limits.maxProperties)
    reportLimitOnce(context, "maxProperties");
  for (let i = 0;i < length; i++) {
    if (!(i in array))
      continue;
    const item = array[i];
    if (Array.isArray(item))
      if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        copy[i] = redactionTruncatedValue;
      } else
        copy[i] = redactArray(item, options, visited, depth + 1, context);
    else if (typeof item === "object" && item !== null)
      if (isBuiltInObject(item))
        copy[i] = item;
      else if (depth + 1 > context.limits.maxDepth) {
        reportLimitOnce(context, "maxDepth");
        copy[i] = redactionTruncatedValue;
      } else
        copy[i] = redactProperties(item, options, visited, depth + 1, context);
    else
      copy[i] = item;
  }
  return copy;
}
function isBuiltInObject(value) {
  return value instanceof Error || value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise || value instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer || ArrayBuffer.isView(value);
}
function shouldFieldRedacted(field, fieldPatterns) {
  for (const fieldPattern of fieldPatterns)
    if (typeof fieldPattern === "string") {
      if (fieldPattern === field)
        return true;
    } else {
      const matched = testFieldPattern(field, fieldPattern);
      if (matched)
        return true;
    }
  return false;
}
function testFieldPattern(field, fieldPattern) {
  if (!fieldPattern.global && !fieldPattern.sticky)
    return fieldPattern.test(field);
  const descriptor = Object.getOwnPropertyDescriptor(fieldPattern, "lastIndex");
  if (descriptor?.writable === false)
    return new RegExp(fieldPattern).test(field);
  return RegExp.prototype[Symbol.search].call(fieldPattern, field) !== -1;
}
function extractPlaceholderNames(template) {
  const placeholders = [];
  for (let i = 0;i < template.length; i++)
    if (template[i] === "{") {
      if (i + 1 < template.length && template[i + 1] === "{") {
        i++;
        continue;
      }
      const closeIndex = template.indexOf("}", i + 1);
      if (closeIndex === -1)
        continue;
      const key = template.slice(i + 1, closeIndex).trim();
      placeholders.push(key);
      i = closeIndex;
    }
  return placeholders;
}
function parsePathSegments(path) {
  const segments = [];
  let current = "";
  let inBracket = false;
  let quotedBracketSegment = false;
  let quote;
  let escaped = false;
  const pushCurrent = (trim = false) => {
    const segment = trim ? current.trimEnd() : current;
    if (segment)
      segments.push(segment);
    current = "";
  };
  for (const char of path) {
    if (quote != null) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === "\\")
        escaped = true;
      else if (char === quote)
        quote = undefined;
      else
        current += char;
      continue;
    }
    if (inBracket && current === "" && /\s/.test(char))
      continue;
    if (inBracket && (char === '"' || char === "'") && current === "") {
      quote = char;
      quotedBracketSegment = true;
      continue;
    }
    if (inBracket && quotedBracketSegment && /\s/.test(char))
      continue;
    if (char === "." && !inBracket) {
      pushCurrent();
      continue;
    }
    if (char === "[") {
      pushCurrent();
      inBracket = true;
      continue;
    }
    if (char === "]") {
      pushCurrent(!quotedBracketSegment);
      inBracket = false;
      quotedBracketSegment = false;
      continue;
    }
    if (char === "?")
      continue;
    current += char;
  }
  pushCurrent();
  return segments;
}
function getRedactedPlaceholderIndices(placeholders, fieldPatterns) {
  const redactedIndices = /* @__PURE__ */ new Set;
  const wildcardIndices = /* @__PURE__ */ new Set;
  for (let i = 0;i < placeholders.length; i++) {
    const placeholder = placeholders[i];
    if (placeholder === "*") {
      wildcardIndices.add(i);
      continue;
    }
    if (shouldFieldRedacted(placeholder, fieldPatterns)) {
      redactedIndices.add(i);
      continue;
    }
    const segments = parsePathSegments(placeholder);
    for (const segment of segments)
      if (shouldFieldRedacted(segment, fieldPatterns)) {
        redactedIndices.add(i);
        break;
      }
  }
  return {
    redactedIndices,
    wildcardIndices
  };
}
function redactMessageArray(message, placeholders, redactedIndices, wildcardIndices, redactedProperties, action, truncateUnmappedValues = false) {
  const result = [];
  let placeholderIndex = 0;
  for (let i = 0;i < message.length; i++)
    if (i % 2 === 0)
      result.push(message[i]);
    else {
      if (wildcardIndices.has(placeholderIndex))
        result.push(redactedProperties);
      else if (redactedIndices.has(placeholderIndex))
        if (action == null || action === "delete")
          result.push("");
        else
          result.push(action(message[i]));
      else {
        const placeholderName = placeholders[placeholderIndex];
        const redactedValue = getPathValue(redactedProperties, placeholderName);
        if (redactedValue.found)
          result.push(redactedValue.value);
        else if (truncateUnmappedValues)
          result.push(redactionTruncatedValue);
        else
          result.push(message[i]);
      }
      placeholderIndex++;
    }
  return result;
}
function getPathValue(properties, path) {
  const segments = parsePathSegments(path);
  if (segments.length < 1)
    return { found: false };
  let value = properties;
  for (const segment of segments) {
    if (typeof value !== "object" && typeof value !== "function" || value == null || !Object.hasOwn(value, segment))
      return { found: false };
    value = value[segment];
  }
  return {
    found: true,
    value
  };
}
function collectRedactedValues(original, redacted, map) {
  for (const key of Object.keys(redacted)) {
    const origVal = original[key];
    const redVal = redacted[key];
    if (origVal !== redVal)
      map.set(origVal, redVal);
    if (typeof origVal === "object" && origVal !== null && typeof redVal === "object" && redVal !== null && !Array.isArray(origVal))
      collectRedactedValues(origVal, redVal, map);
  }
}
function getRedactedValues(original, redacted) {
  const map = /* @__PURE__ */ new Map;
  collectRedactedValues(original, redacted, map);
  return map;
}
function redactMessageByValues(message, redactedValues, truncateUnmappedValues = false) {
  if (redactedValues.size === 0 && !truncateUnmappedValues)
    return message;
  const result = [];
  for (let i = 0;i < message.length; i++)
    if (i % 2 === 0)
      result.push(message[i]);
    else {
      const val = message[i];
      if (redactedValues.has(val))
        result.push(redactedValues.get(val));
      else if (truncateUnmappedValues)
        result.push(redactionTruncatedValue);
      else
        result.push(val);
    }
  return result;
}
// packages/workflow-cli/src/diagnostics.ts
var LOG_CATEGORY = ["msb-workflow"];
var META_CATEGORY = ["logtape", "meta"];
var IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var SECRET_KEY_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
var REDACTED = "[REDACTED]";
var MAX_RECORD_BYTES = 4096;
var MAX_RECORDS_PER_RUN = 512;
var MAX_RETAINED_RUN_FILES = 64;
var MAX_REDACTION_DEPTH = 20;
var LEVELS = ["debug", "info", "warning", "error"];
var LEVEL_RANK = { trace: 0, debug: 1, info: 2, warning: 3, error: 4, fatal: 5 };
var RESERVED_KEYS = ["runIdentity", "commandIdentity", "sequence", "eventKind", "level", "message", "logger", "@timestamp"];
var CORRELATION_KEYS = ["stationId", "beadId", "generation"];
var encoder = new TextEncoder;
var formatLine = getJsonLinesFormatter({ properties: "flatten" });
function isIdentity(value) {
  return typeof value === "string" && IDENTITY_PATTERN.test(value);
}
function isLevel(value) {
  return typeof value === "string" && LEVELS.includes(value);
}
function codedError(code) {
  return Object.assign(new Error(code), { code });
}
function classify(stage, error) {
  const code = error?.code;
  if (typeof code === "string" && code.length > 0)
    return `${stage}: ${code}`;
  return `${stage}: ${error instanceof Error ? error.name : "UNKNOWN"}`;
}
var DIAGNOSTICS_SEGMENTS = ["my-second-brain-playground", "workflow-cli", "diagnostics"];
function isOwned(stat) {
  return typeof process.geteuid !== "function" || stat.uid === process.geteuid();
}
function ownedDirectory(path) {
  let existing;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT")
      return null;
    throw error;
  }
  if (existing.isSymbolicLink())
    throw codedError("ELOOP");
  if (!existing.isDirectory())
    throw codedError("ENOTDIR");
  if (!isOwned(existing))
    throw codedError("EOWNER");
  return existing;
}
function ensureDirectory(stateHome) {
  if (stateHome.length === 0 || !isAbsolute(stateHome))
    throw codedError("ROOT_UNSAFE");
  let root;
  try {
    root = ownedDirectory(stateHome);
  } catch {
    throw codedError("ROOT_UNSAFE");
  }
  if (root === null)
    throw codedError("ROOT_UNSAFE");
  let current = stateHome;
  for (const segment of DIAGNOSTICS_SEGMENTS) {
    current = `${current}${sep}${segment}`;
    const existing = ownedDirectory(current);
    if (existing === null)
      mkdirSync(current, { mode: 448 });
    else if ((existing.mode & 511) !== 448)
      throw codedError("EMODE");
  }
  return current;
}
function modifiedAt(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function pruneRunFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).map((name) => ({ name, mtime: modifiedAt(join(directory, name)) }));
  } catch {
    return;
  }
  entries.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
  const excess = entries.length - (MAX_RETAINED_RUN_FILES - 1);
  for (const entry of entries.slice(0, Math.max(0, excess))) {
    try {
      unlinkSync(join(directory, entry.name));
    } catch {}
  }
}
function openRunFile(stateHome, runIdentity) {
  const directory = ensureDirectory(stateHome);
  pruneRunFiles(directory);
  const file = join(directory, `${runIdentity}.jsonl`);
  const fd = openSync(file, "wx", 384);
  try {
    if ((fstatSync(fd).mode & 511) !== 384)
      fchmodSync(fd, 384);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return { file, fd };
}
function replaceSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets)
    result = result.replaceAll(secret, REDACTED);
  return result;
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function redactKnownValues(value, secrets, ancestors) {
  if (typeof value === "string")
    return replaceSecrets(value, secrets);
  if (value instanceof Error)
    return { name: value.name };
  if (!Array.isArray(value) && !isPlainObject(value))
    return value;
  if (ancestors.includes(value) || ancestors.length >= MAX_REDACTION_DEPTH)
    throw codedError("UNSERIALIZABLE");
  const next = [...ancestors, value];
  if (Array.isArray(value))
    return value.map((item) => redactKnownValues(item, secrets, next));
  const result = {};
  for (const [key, item] of Object.entries(value))
    result[key] = redactKnownValues(item, secrets, next);
  return result;
}
function ensureGlobalConfiguration() {
  if (getConfig() !== null)
    return;
  configureSync({
    sinks: {},
    loggers: [{ category: [...META_CATEGORY], lowestLevel: null }],
    contextLocalStorage: new AsyncLocalStorage
  });
}
function splitLevel(properties) {
  const { level, ...own } = properties;
  return { level: isLevel(level) ? level : "info", own };
}
function fileTarget(stateHome, runIdentity) {
  const opened = openRunFile(stateHome, runIdentity);
  return {
    file: opened.file,
    lowestLevel: "debug",
    write: (line) => {
      writeSync(opened.fd, line);
    },
    flush: () => fsyncSync(opened.fd),
    close: () => {
      fsyncSync(opened.fd);
      closeSync(opened.fd);
    }
  };
}
function stderrTarget(write) {
  return { file: null, lowestLevel: "warning", write, flush: () => {
    return;
  }, close: () => {
    return;
  } };
}

class DiagnosticsRun {
  runIdentity;
  commandIdentity;
  secrets;
  target = null;
  written = 0;
  dropped = 0;
  refused = 0;
  failure = null;
  sequence = 0;
  stationId = null;
  status = null;
  outcome = "none";
  scopedConfig;
  constructor(runIdentity, commandIdentity, secrets) {
    this.runIdentity = runIdentity;
    this.commandIdentity = commandIdentity;
    this.secrets = secrets;
    const redacting = redactByField((record) => this.write(record), { fieldPatterns: [SECRET_KEY_PATTERN], action: () => REDACTED });
    const diagnostics = (record) => {
      try {
        const known = secrets();
        redacting({ ...record, message: redactKnownValues(record.message, known, []), properties: redactKnownValues(record.properties, known, []) });
      } catch {
        this.outcome = "unserializable";
      }
    };
    const meta = (record) => {
      if (this.failure === null && typeof record.rawMessage === "string")
        this.failure = `meta: ${record.rawMessage.slice(0, 80)}`;
    };
    this.scopedConfig = {
      sinks: { diagnostics, meta },
      loggers: [
        { category: [...LOG_CATEGORY], sinks: ["diagnostics"], lowestLevel: "debug", parentSinks: "override" },
        { category: [...META_CATEGORY], sinks: ["meta"], lowestLevel: "warning", parentSinks: "override" }
      ]
    };
  }
  open(context) {
    try {
      if (!isIdentity(this.runIdentity) || !isIdentity(this.commandIdentity))
        throw codedError("IDENTITY_INVALID");
      this.target = context.sink === "stderr" ? stderrTarget(context.writeStderr ?? ((line) => process.stderr.write(line))) : fileTarget(context.stateHome, this.runIdentity);
    } catch (error) {
      this.fail("open", error);
    }
  }
  log(eventKind, properties) {
    if (this.status !== null)
      return;
    this.sequence += 1;
    if (this.target === null || this.written >= MAX_RECORDS_PER_RUN) {
      this.dropped += 1;
      return;
    }
    if (!isIdentity(eventKind)) {
      this.refuse({ reason: "event-kind" });
      return;
    }
    const { level, own } = splitLevel(properties);
    const outcome = this.emit(level, eventKind, own);
    if (outcome === "oversized" || outcome === "unserializable")
      this.refuse({ reason: outcome, refusedEventKind: eventKind });
    else if (outcome !== "written")
      this.dropped += 1;
  }
  setStation(stationId) {
    if (typeof stationId === "string" && stationId.length > 0)
      this.stationId = stationId;
  }
  flush() {
    if (this.status !== null || this.target === null)
      return;
    try {
      this.target.flush();
    } catch (error) {
      this.fail("flush", error);
    }
  }
  dispose() {
    if (this.status !== null)
      return this.status;
    let closed = true;
    const file = this.target?.file ?? null;
    if (this.target !== null) {
      if (this.dropped > 0) {
        this.sequence += 1;
        this.emit("warning", "diagnostics.truncated", { droppedRecords: this.dropped });
      }
      try {
        this.target.close();
      } catch (error) {
        this.fail("dispose", error);
        closed = false;
      }
      this.target = null;
    }
    this.status = { file, written: this.written, dropped: this.dropped, refused: this.refused, failure: this.failure, closed };
    return this.status;
  }
  fail(stage, error) {
    if (this.failure === null)
      this.failure = classify(stage, error);
  }
  refuse(marker) {
    this.refused += 1;
    this.emit("warning", "diagnostics.refused", marker);
  }
  correlate(eventKind, own) {
    const properties = { runIdentity: this.runIdentity, commandIdentity: this.commandIdentity, sequence: this.sequence, eventKind };
    const stationId = typeof own.stationId === "string" && own.stationId.length > 0 ? own.stationId : this.stationId;
    if (stationId !== null)
      properties.stationId = stationId;
    for (const key of ["beadId", "generation"]) {
      const value = own[key];
      if (typeof value === "string" && value.length > 0 || typeof value === "number")
        properties[key] = value;
    }
    for (const [key, value] of Object.entries(own)) {
      if (!RESERVED_KEYS.includes(key) && !CORRELATION_KEYS.includes(key))
        properties[key] = value;
    }
    return properties;
  }
  emit(level, eventKind, own) {
    const properties = this.correlate(eventKind, own);
    this.outcome = "none";
    try {
      ensureGlobalConfiguration();
      withConfigSync(this.scopedConfig, () => {
        getLogger(LOG_CATEGORY).emit({ level, message: [eventKind], rawMessage: eventKind, timestamp: Date.now(), properties });
      });
    } catch (error) {
      this.fail("log", error);
      this.outcome = "failed";
    }
    return this.outcome;
  }
  write(record) {
    const target = this.target;
    if (target === null)
      return;
    if (LEVEL_RANK[record.level] < LEVEL_RANK[target.lowestLevel]) {
      this.outcome = "written";
      return;
    }
    let line;
    try {
      line = replaceSecrets(formatLine(record), this.secrets());
    } catch {
      this.outcome = "unserializable";
      return;
    }
    if (encoder.encode(line).byteLength > MAX_RECORD_BYTES) {
      this.outcome = "oversized";
      return;
    }
    try {
      target.write(line);
      this.written += 1;
      this.outcome = "written";
    } catch (error) {
      this.fail("write", error);
      this.outcome = "failed";
    }
  }
}
function contained(fallback, action) {
  try {
    return action();
  } catch {
    return fallback;
  }
}
function openDiagnostics(context) {
  const provider = context.knownSecretValues;
  const secrets = () => (typeof provider === "function" ? provider() : provider ?? []).filter((secret) => typeof secret === "string" && secret.length > 0);
  const run = new DiagnosticsRun(context.runIdentity, context.commandIdentity, secrets);
  run.open(context);
  const disposedFallback = { file: null, written: 0, dropped: 0, refused: 0, failure: "dispose: UNKNOWN", closed: false };
  return {
    log: (eventKind, properties = {}) => contained(undefined, () => run.log(eventKind, properties)),
    setStation: (stationId) => contained(undefined, () => run.setStation(stationId)),
    flush: () => contained(undefined, () => run.flush()),
    dispose: () => contained(disposedFallback, () => run.dispose())
  };
}

// packages/workflow-cli/src/lock-adapter.ts
import { closeSync as closeSync2, constants, fstatSync as fstatSync2, openSync as openSync2 } from "fs";
import { dlopen, FFIType, read } from "bun:ffi";
var LOCK_EX = 2;
var LOCK_NB = 4;
var LOCK_UN = 8;
var EWOULDBLOCK = 35;
var LOCK_WAIT_MILLISECONDS = 2000;
var LOCK_POLL_MILLISECONDS = 25;

class LockFailure extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
function currentUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}
function assertPrivateLockDescriptor(lockPath, stat, expected) {
  const uid = currentUid();
  if (!stat.isFile())
    throw new LockFailure("unsafe", `${lockPath} is not a regular file`);
  if (uid !== null && stat.uid !== uid)
    throw new LockFailure("unsafe", `${lockPath} is not owned by the effective user`);
  if ((stat.mode & 511) !== 384)
    throw new LockFailure("unsafe", `${lockPath} must have mode 0600`);
  if (stat.nlink !== 1)
    throw new LockFailure("unsafe", `${lockPath} must have exactly one link`);
  if (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino))
    throw new LockFailure("unsafe", `${lockPath} changed identity while locked`);
}
function createDarwinFlockAdapter() {
  return {
    platform: "darwin",
    async withExclusive(lockPath, action) {
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
        __error: { args: [], returns: FFIType.ptr }
      });
      let descriptor = null;
      try {
        try {
          descriptor = openSync2(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 384);
        } catch (error) {
          const code = error.code;
          throw new LockFailure(code === "ELOOP" ? "unsafe" : "unavailable", `lock file open failed${typeof code === "string" ? ` (${code})` : ""}`);
        }
        const opened = fstatSync2(descriptor);
        assertPrivateLockDescriptor(lockPath, opened);
        const started = performance.now();
        for (;; ) {
          if (library.symbols.flock(descriptor, LOCK_EX | LOCK_NB) === 0)
            break;
          const pointer = library.symbols.__error();
          if (pointer === null)
            throw new LockFailure("unavailable", "flock errno pointer was null");
          const errorNumber = read.i32(pointer);
          if (errorNumber !== EWOULDBLOCK)
            throw new LockFailure("unavailable", `flock failed with errno ${errorNumber}`);
          if (performance.now() - started >= LOCK_WAIT_MILLISECONDS)
            throw new LockFailure("busy", `lock remained busy for ${LOCK_WAIT_MILLISECONDS} ms`);
          await Bun.sleep(LOCK_POLL_MILLISECONDS);
        }
        assertPrivateLockDescriptor(lockPath, fstatSync2(descriptor), opened);
        return await action();
      } finally {
        if (descriptor !== null) {
          library.symbols.flock(descriptor, LOCK_UN);
          closeSync2(descriptor);
        }
        library.close();
      }
    }
  };
}
function createUnsupportedLockAdapter(platform) {
  return {
    platform,
    withExclusive: async () => Promise.reject(new LockFailure("unsupported", `process-safe locking is unsupported on ${platform}; only darwin is admitted`))
  };
}
function lockAdapterFor(platform = process.platform) {
  return platform === "darwin" ? createDarwinFlockAdapter() : createUnsupportedLockAdapter(platform);
}

// packages/workflow-cli/src/adapters/beads.ts
import { createHash } from "crypto";
import { accessSync, constants as constants2, readFileSync, realpathSync, statSync as statSync2 } from "fs";
import { isAbsolute as isAbsolute2, join as join2 } from "path";

// packages/workflow-cli/src/command-contract.ts
var CLI_NAME = "msb-workflow";
var ENVELOPE_VERSION = 1;
var CONTRACT_VERSION = "1.0.0";
var GENERATION_CONVENTION_VERSION = "1.0.0";
var MACHINE_MODE = "--json";
var REDACTED2 = "[REDACTED]";
var SECRET_KEY_PATTERN2 = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/i;
var CAUSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
var EXIT = { success: 0, internal: 1, usage: 2, domain: 3, schema: 4, unavailable: 75 };
var EXIT_MEANINGS = { "0": "success", "1": "internal", "2": "usage", "3": "domain", "4": "schema", "75": "unavailable" };
var FAILURE_CLASSES = ["usage", "domain", "schema", "internal", "unavailable"];
var OUTCOMES = ["success", "refused", "failed", "unknown"];
var EFFECT_CLASSES = ["inspect", "repository-local", "external"];
var TRANSACTION_STATES = ["unchanged", "completed", "partially-completed", "rolled-back", "unknown"];
function exitFor(failureClass) {
  return EXIT[failureClass ?? "success"];
}
var COMMANDS = [
  { identity: "msb-workflow.help", argv: "msb-workflow --help", effectClass: "inspect", description: "Print one usage line and one example" },
  { identity: "msb-workflow.discover", argv: "msb-workflow --discover --json", effectClass: "inspect", description: "Describe the contract, commands, effect classes, exit meanings, machine mode and the private binding schema" },
  { identity: "msb-workflow.inspect", argv: "msb-workflow inspect --workspace <absolute-path> [--session <id>]", effectClass: "inspect", description: "Check the pinned bd executable, the selected store, the state root, the binding, the marker and the lock files without writing" },
  { identity: "msb-workflow.bind", argv: "msb-workflow bind --workspace <absolute-path> --bead <bead-id> [--session <id>] [--evidence <absolute-file>]", effectClass: "repository-local", description: "Bind this session to one Bead in the selected store, or refresh the same owner; the one private local write" },
  { identity: "msb-workflow.recover", argv: "msb-workflow recover --workspace <absolute-path> [--session <id>]", effectClass: "inspect", description: "Rebuild this session's Resume Panel from current read-only bd reads and name one next safe action" },
  { identity: "msb-workflow.hook", argv: "msb-workflow hook", effectClass: "repository-local", description: "Deliver session guidance or the Resume Panel for one Harness event read from stdin; Harness JSON out, always exit 0" }
];
function commandDeclaration(identity) {
  const declaration = COMMANDS.find((command) => command.identity === identity);
  if (declaration === undefined)
    throw new Error(`undeclared command identity: ${identity}`);
  return declaration;
}
var HELP_TEXT = [
  "usage: msb-workflow <inspect|bind|recover|hook> [options] [--json]",
  "example: msb-workflow recover --workspace /absolute/path/to/workspace --session <id> --json",
  "",
  "commands:",
  ...COMMANDS.slice(2).map((command) => `  ${command.argv}`),
  "",
  "--session or CODEX_SESSION_ID supplies the session; both present and different refuses.",
  "MSB_WORKFLOW_BD_EXECUTABLE names the pinned bd for inspect and bind; recover and hook use the bound one.",
  "Add --json anywhere for one Contract Core 1.0.0 envelope on stdout. Run msb-workflow --discover --json for the machine contract.",
  ""
].join(`
`);
var HELP_ACTION = "msb-workflow --help";
var DISCOVER_ACTION = "msb-workflow --discover --json";
var BINDING_SCHEMA = {
  schemaVersion: 3,
  address: "<state-root>/my-second-brain-playground/workflow-cli/recovery/sessions/<session-id>.json",
  markerAddress: "<state-root>/my-second-brain-playground/workflow-cli/recovery/sessions/<session-id>.marker.json",
  stateRootOrder: ["MSB_WORKFLOW_STATE_HOME", "XDG_STATE_HOME", "$HOME/.local/state"],
  required: ["schemaVersion", "sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "beadObservedAt", "sourceRepository", "evidencePath", "observedAt"],
  additionalProperties: false,
  nullable: ["evidencePath"],
  sessionIdentityPattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  observedAt: "UTC RFC 3339 timestamp ending in Z",
  limitBytes: 16384,
  freshForSeconds: 3600,
  futureSkewSeconds: 300,
  fileMode: "0600",
  directoryMode: "0700"
};
function discovery() {
  return {
    name: CLI_NAME,
    contractVersion: CONTRACT_VERSION,
    generationConventionVersion: GENERATION_CONVENTION_VERSION,
    commands: COMMANDS,
    exitMeanings: EXIT_MEANINGS,
    machineMode: MACHINE_MODE,
    logtape: true,
    bindingSchema: BINDING_SCHEMA
  };
}
function machineMode(argv) {
  return argv.includes(MACHINE_MODE);
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function validGuidance(facts) {
  const hasNext = facts.nextAction !== null;
  const hasHandoff = facts.handoff !== null;
  if (facts.outcome === "success")
    return true;
  return hasNext !== hasHandoff;
}
function validCause(facts) {
  if (facts.failureClass === null)
    return facts.causeCode === null;
  return typeof facts.causeCode === "string" && CAUSE_CODE_PATTERN.test(facts.causeCode) && facts.causeCode.startsWith(`${facts.failureClass.toUpperCase()}_`);
}
var nullableOr = (accept) => (value) => value === null || accept(value);
var isDelay = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var isHandoff = (value) => isPlainObject2(value) && nonBlank(value.reason) && Array.isArray(value.prerequisites) && value.prerequisites.every(nonBlank);
var isUnresolved = (state) => state === "partially-completed" || state === "unknown";
var FIELD_RULES = [
  ["commandIdentity", (facts) => COMMANDS.some((command) => command.identity === facts.commandIdentity)],
  ["runIdentity", (facts) => nonBlank(facts.runIdentity)],
  ["outcome", (facts) => OUTCOMES.includes(facts.outcome)],
  ["failureClass", (facts) => facts.failureClass === null || FAILURE_CLASSES.includes(facts.failureClass)],
  ["outcome/failureClass", (facts) => facts.outcome === "success" === (facts.failureClass === null)],
  ["causeCode", validCause],
  ["message", (facts) => typeof facts.message === "string"],
  ["effectClass", (facts) => EFFECT_CLASSES.includes(facts.effectClass)],
  ["transactionState", (facts) => TRANSACTION_STATES.includes(facts.transactionState)],
  ["retryable", (facts) => typeof facts.retryable === "boolean"],
  ["retryDelayMilliseconds", (facts) => nullableOr(isDelay)(facts.retryDelayMilliseconds)],
  ["nextAction", (facts) => nullableOr(nonBlank)(facts.nextAction)],
  ["availablePaths", (facts) => Array.isArray(facts.availablePaths) && facts.availablePaths.every(nonBlank)],
  ["repairAction", (facts) => nullableOr(nonBlank)(facts.repairAction)],
  ["handoff", (facts) => nullableOr(isHandoff)(facts.handoff)],
  ["nextAction/handoff", validGuidance],
  ["success/transactionState", (facts) => facts.outcome !== "success" || !isUnresolved(facts.transactionState)],
  ["retryable/transactionState", (facts) => !isUnresolved(facts.transactionState) || !facts.retryable],
  ["result", (facts) => nullableOr(isPlainObject2)(facts.result)]
];
function validationIssues(facts) {
  return FIELD_RULES.filter(([, holds]) => !holds(facts)).map(([field]) => field);
}
function redactString(value, knownSecretValues) {
  let output = value;
  for (const secret of knownSecretValues) {
    if (secret.length > 0)
      output = output.split(secret).join(REDACTED2);
  }
  return output;
}
function redactValue(value, knownSecretValues, depth) {
  if (depth > 64)
    throw new Error("redaction depth exceeded");
  if (typeof value === "string")
    return redactString(value, knownSecretValues);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, knownSecretValues, depth + 1));
  if (isPlainObject2(value)) {
    const output = {};
    for (const [key, child] of Object.entries(value))
      output[redactString(key, knownSecretValues)] = SECRET_KEY_PATTERN2.test(key) ? REDACTED2 : redactValue(child, knownSecretValues, depth + 1);
    return output;
  }
  return value;
}
function redactText(value, knownSecretValues) {
  return redactString(value, knownSecretValues);
}
function collectSecretValues(value, depth = 0, found = []) {
  if (depth > 64)
    return found;
  if (Array.isArray(value))
    for (const item of value)
      collectSecretValues(item, depth + 1, found);
  else if (isPlainObject2(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN2.test(key) && typeof child === "string" && child.length > 0)
        found.push(child);
      else
        collectSecretValues(child, depth + 1, found);
    }
  }
  return found;
}
function envelopeFrom(facts, knownSecretValues) {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    contractVersion: CONTRACT_VERSION,
    commandIdentity: facts.commandIdentity,
    runIdentity: facts.runIdentity,
    outcome: facts.outcome,
    failureClass: facts.failureClass,
    causeCode: facts.causeCode,
    message: redactString(facts.message, knownSecretValues),
    effectClass: facts.effectClass,
    transactionState: facts.transactionState,
    retryable: facts.retryable,
    retryDelayMilliseconds: facts.retryDelayMilliseconds,
    nextAction: facts.nextAction === null ? null : redactString(facts.nextAction, knownSecretValues),
    availablePaths: facts.availablePaths.map((path) => redactString(path, knownSecretValues)),
    repairAction: facts.repairAction === null ? null : redactString(facts.repairAction, knownSecretValues),
    handoff: facts.handoff === null ? null : { reason: redactString(facts.handoff.reason, knownSecretValues), prerequisites: facts.handoff.prerequisites.map((item) => redactString(item, knownSecretValues)) },
    result: facts.result === null ? null : redactValue(facts.result, knownSecretValues, 0)
  };
}
function fallbackEnvelope(facts, issues) {
  const transactionState = TRANSACTION_STATES.includes(facts.transactionState) ? facts.transactionState : "unknown";
  const commandIdentity = COMMANDS.some((command) => command.identity === facts.commandIdentity) ? facts.commandIdentity : "msb-workflow.help";
  const runIdentity = nonBlank(facts.runIdentity) ? facts.runIdentity : "run-unknown";
  const effectClass = EFFECT_CLASSES.includes(facts.effectClass) ? facts.effectClass : commandDeclaration(commandIdentity).effectClass;
  return {
    envelopeVersion: ENVELOPE_VERSION,
    contractVersion: CONTRACT_VERSION,
    commandIdentity,
    runIdentity,
    outcome: "failed",
    failureClass: "internal",
    causeCode: "INTERNAL_RENDER_FAILURE",
    message: `public envelope could not be rendered: ${issues.join(", ")}`,
    effectClass,
    transactionState,
    retryable: false,
    retryDelayMilliseconds: null,
    nextAction: null,
    availablePaths: [],
    repairAction: "Inspect the workspace with msb-workflow inspect and report the render failure with the run identity",
    handoff: { reason: "the command outcome could not be rendered as a public envelope", prerequisites: ["Inspect the workspace and session with msb-workflow inspect", "Report the run identity to the helper owner"] },
    result: { station: "render-failed" }
  };
}
function serialize(envelope) {
  const text = JSON.stringify(envelope);
  if (typeof text !== "string")
    throw new Error("envelope did not serialize");
  return `${text}
`;
}
function humanValue(value) {
  if (typeof value === "string")
    return value;
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}
function humanSuccess(envelope) {
  const result = envelope.result ?? {};
  if (typeof result.resumePanel === "string")
    return `${result.resumePanel}
`;
  const lines = [];
  if (typeof result.station === "string")
    lines.push(`station: ${result.station}`);
  for (const [key, value] of Object.entries(result)) {
    if (key !== "station")
      lines.push(`${key}: ${humanValue(value)}`);
  }
  if (lines.length === 0)
    lines.push(envelope.message);
  if (envelope.nextAction !== null)
    lines.push(`next: ${envelope.nextAction}`);
  return `${lines.join(`
`)}
`;
}
function humanFailure(envelope) {
  const repair = envelope.repairAction ?? (envelope.handoff === null ? `run ${HELP_ACTION}` : envelope.handoff.reason);
  const line = `${CLI_NAME}: ${envelope.causeCode ?? "FAILED"}: ${envelope.message}; repair: ${repair}`.replace(/[\r\n]+/g, " ");
  return `${line}
`;
}
function renderEnvelope(envelope, mode) {
  const exit = exitFor(envelope.failureClass);
  if (mode === "machine")
    return { stdout: serialize(envelope), stderr: "", exit };
  if (envelope.outcome === "success")
    return { stdout: humanSuccess(envelope), stderr: "", exit };
  return { stdout: "", stderr: humanFailure(envelope), exit };
}
function renderOutcome(facts, mode, options = {}) {
  const knownSecretValues = options.knownSecretValues ?? [];
  const issues = validationIssues(facts);
  if (issues.length === 0) {
    try {
      return renderEnvelope(envelopeFrom(facts, knownSecretValues), mode);
    } catch (error) {
      issues.push(error instanceof Error && error.message.length > 0 ? error.message.slice(0, 80) : "serialization");
    }
  }
  return renderEnvelope(fallbackEnvelope(facts, issues), mode);
}
function renderDiscoveryHuman() {
  const data = discovery();
  const lines = [`${data.name} contract ${data.contractVersion} (generation convention ${data.generationConventionVersion}); machine mode ${data.machineMode}; logtape ${data.logtape}`];
  for (const command of data.commands)
    lines.push(`${command.identity} [${command.effectClass}]: ${command.argv}`);
  lines.push(`exits: ${Object.entries(data.exitMeanings).map(([code, meaning]) => `${code}=${meaning}`).join(" ")}`);
  lines.push(`binding schema v${data.bindingSchema.schemaVersion} at ${data.bindingSchema.address}`);
  return `${lines.join(`
`)}
`;
}

// packages/workflow-cli/src/adapters/native-process.ts
var DEFAULT_TIMEOUT_MILLISECONDS = 20000;
function baseEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value !== undefined)
      env[key] = value;
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}
async function runBounded(command, options = {}) {
  let child;
  try {
    child = Bun.spawn([...command], { ...options.cwd === undefined ? {} : { cwd: options.cwd }, env: { ...baseEnvironment(), ...options.env ?? {} }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { status: "failed-to-start", exit: null, stdout: "", stderr: "" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exit = await child.exited;
  clearTimeout(timer);
  if (timedOut)
    return { status: "timed-out", exit: null, stdout, stderr };
  return { status: "exited", exit, stdout, stderr };
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
function describeFailure(result) {
  if (result.status === "exited")
    return `exit ${result.exit}`;
  return result.status;
}

// packages/workflow-cli/src/adapters/beads.ts
var PINNED_BD_VERSION = "1.3.0";
var PINNED_BD_REVISION = "f45b249ce6b4";
var VERSION_LINE = /^bd version (\S+) \(\S+: (?:.*@)?([0-9a-f]+)\)$/;
var ABSENT_ISSUE_VALUES = new Set(["no issues found matching the provided IDs"]);
var REASON_LIMIT = 200;
function checkExecutable(executable, pin) {
  if (executable === null || executable.length === 0)
    return { status: "invalid", reason: "MSB_WORKFLOW_BD_EXECUTABLE is not set; PATH discovery is never used", digest: null };
  if (!isAbsolute2(executable))
    return { status: "invalid", reason: "bd executable path must be absolute", digest: null };
  if (executable !== pin.executable)
    return { status: "invalid", reason: `bd executable ${executable} is not the accepted ${pin.executable}`, digest: null };
  let digest;
  try {
    if (realpathSync(executable) !== executable)
      return { status: "invalid", reason: "bd executable path must be canonical (no symlinks)", digest: null };
    if (!statSync2(executable).isFile())
      return { status: "invalid", reason: "bd executable is not a regular file", digest: null };
    accessSync(executable, constants2.X_OK);
    digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  } catch {
    return { status: "invalid", reason: "bd executable is missing or not executable", digest: null };
  }
  if (digest !== pin.sha256)
    return { status: "invalid", reason: `bd executable ${executable} hashes ${digest}, not the accepted ${pin.sha256}`, digest: null };
  return { status: "valid", reason: null, digest };
}
function parseVersionLine(stdout) {
  const match = VERSION_LINE.exec(stdout.split(`
`)[0] ?? "");
  return match === null ? null : { version: match[1], revision: match[2] };
}
function bounded(text) {
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}\u2026` : text;
}
function errorValue(parsed) {
  return isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : null;
}
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function identified(value) {
  if (!isRecord(value))
    return null;
  const id = stringField(value, "id");
  if (id === null)
    return null;
  return { id, record: value, title: stringField(value, "title") ?? "", status: stringField(value, "status") ?? "", awaitType: stringField(value, "await_type") };
}
function dependencyOf(value) {
  const entry = identified(value);
  if (entry === null)
    return null;
  return { id: entry.id, title: entry.title, status: entry.status, issueType: stringField(entry.record, "issue_type") ?? "", dependencyType: stringField(entry.record, "dependency_type") ?? "", awaitType: entry.awaitType };
}
function commentOf(value) {
  if (!isRecord(value))
    return null;
  return { author: stringField(value, "author") ?? "", createdAt: stringField(value, "created_at") ?? "", text: stringField(value, "text") ?? "" };
}
function beadOf(issue, id) {
  return {
    id,
    title: stringField(issue, "title") ?? "",
    status: stringField(issue, "status") ?? "",
    assignee: stringField(issue, "assignee"),
    parent: stringField(issue, "parent"),
    labels: stringList(issue.labels),
    specId: stringField(issue, "spec_id"),
    externalRef: stringField(issue, "external_ref"),
    updatedAt: stringField(issue, "updated_at"),
    dependencies: (Array.isArray(issue.dependencies) ? issue.dependencies : []).map(dependencyOf).filter((item) => item !== null),
    comments: (Array.isArray(issue.comments) ? issue.comments : []).map(commentOf).filter((item) => item !== null)
  };
}
function gateOf(value) {
  const entry = identified(value);
  return entry === null ? null : { id: entry.id, title: entry.title, status: entry.status, awaitType: entry.awaitType };
}
function createBeadsReader(configuration) {
  const storePath = join2(configuration.workspace, ".beads");
  const secrets = [];
  const observe = (parsed) => {
    for (const value of collectSecretValues(parsed))
      if (!secrets.includes(value))
        secrets.push(value);
  };
  const bd = (args) => runBounded([configuration.executable, ...args], { cwd: configuration.cwd, env: { BEADS_DIR: storePath } });
  const readJson = async (args) => {
    const result = await bd(args);
    if (result.status !== "exited")
      return { kind: "unavailable", reason: `bd ${args[0]} ${describeFailure(result)}` };
    const parsed = parseJson(result.stdout);
    if (parsed === undefined)
      return { kind: "unavailable", reason: `bd ${args[0]} returned no JSON (${describeFailure(result)})` };
    observe(parsed);
    const error = errorValue(parsed);
    if (error !== null)
      return { kind: "error", value: error };
    return { kind: "json", value: parsed };
  };
  const readObject = async (args) => {
    const reply = await readJson(args);
    if (reply.kind === "error")
      return { kind: "stop", read: { status: "unavailable", reason: `bd ${args.slice(0, 2).join(" ")}: ${bounded(reply.value)}` } };
    if (reply.kind === "unavailable")
      return { kind: "stop", read: { status: "unavailable", reason: reply.reason } };
    return isRecord(reply.value) ? { kind: "object", value: reply.value } : { kind: "stop", read: { status: "unavailable", reason: `bd ${args[0]} returned no JSON object` } };
  };
  async function checkVersion() {
    const version = await bd(["version"]);
    if (version.status !== "exited" || version.exit !== 0)
      return { status: "unavailable", reason: `bd version ${describeFailure(version)}` };
    const parsed = parseVersionLine(version.stdout);
    if (parsed === null || parsed.version !== PINNED_BD_VERSION || parsed.revision !== PINNED_BD_REVISION)
      return { status: "mismatch", reason: `bd executable is not the verified ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}` };
    return null;
  }
  async function checkWhere() {
    const where = await readObject(["where", "--readonly", "--json"]);
    if (where.kind === "stop")
      return where.read;
    const wherePath = stringField(where.value, "path");
    if (wherePath !== storePath)
      return { status: "mismatch", reason: `bd resolved store ${wherePath ?? "(none)"} instead of ${storePath}` };
    return { prefix: stringField(where.value, "prefix") ?? "" };
  }
  async function checkConfig(prefix) {
    const config = await readObject(["config", "list", "--readonly", "--json"]);
    if (config.kind === "stop")
      return config.read;
    const configuredPrefix = stringField(config.value, "issue_prefix");
    if (prefix.length === 0 || configuredPrefix !== prefix)
      return { status: "mismatch", reason: `store prefix ${prefix || "(none)"} and effective configuration ${configuredPrefix ?? "(none)"} disagree` };
    return null;
  }
  async function checkContext() {
    const context = await readObject(["context", "--readonly", "--json"]);
    if (context.kind === "stop")
      return context.read;
    const beadsDir = stringField(context.value, "beads_dir");
    if (context.value.is_redirected === true)
      return { status: "mismatch", reason: "bd context reports a redirected store" };
    if (beadsDir !== storePath)
      return { status: "mismatch", reason: `bd context names store ${beadsDir ?? "(none)"} instead of ${storePath}` };
    return null;
  }
  async function verifyStore(cwdIsGitRepository) {
    const executable = checkExecutable(configuration.executable, configuration.pin);
    if (executable.status === "invalid")
      return { status: "executable-invalid", reason: executable.reason ?? "bd executable is invalid" };
    const version = await checkVersion();
    if (version !== null)
      return version;
    const where = await checkWhere();
    if ("status" in where)
      return where;
    const config = await checkConfig(where.prefix);
    if (config !== null)
      return config;
    const context = cwdIsGitRepository ? await checkContext() : null;
    if (context !== null)
      return context;
    return { status: "verified", store: { executable: configuration.executable, executableDigest: executable.digest ?? "", version: `${PINNED_BD_VERSION}@${PINNED_BD_REVISION}`, storePath, prefix: where.prefix } };
  }
  async function readBead(id) {
    const reply = await readJson(["show", id, "--readonly", "--json", "--include-comments"]);
    if (reply.kind === "unavailable")
      return { status: "unavailable", reason: reply.reason };
    if (reply.kind === "error")
      return ABSENT_ISSUE_VALUES.has(reply.value.trim()) ? { status: "missing", reason: bounded(reply.value) } : { status: "unavailable", reason: `bd show: ${bounded(reply.value)}` };
    const issue = Array.isArray(reply.value) ? reply.value[0] : reply.value;
    if (!isRecord(issue) || stringField(issue, "id") !== id)
      return { status: "missing", reason: `bd show returned no issue with id ${id}` };
    return { status: "found", bead: beadOf(issue, id) };
  }
  async function readGates() {
    const reply = await readJson(["gate", "list", "--all", "--readonly", "--json"]);
    if (reply.kind === "unavailable")
      return { status: "unavailable", reason: reply.reason };
    if (reply.kind === "error")
      return { status: "unavailable", reason: `bd gate list: ${bounded(reply.value)}` };
    return { status: "available", gates: (Array.isArray(reply.value) ? reply.value : []).map(gateOf).filter((gate) => gate !== null) };
  }
  async function readPrime() {
    const result = await bd(["prime", "--readonly", "--hook-json"]);
    if (result.status !== "exited" || result.exit !== 0)
      return null;
    const parsed = parseJson(result.stdout);
    if (!isRecord(parsed))
      return null;
    observe(parsed);
    const specific = parsed.hookSpecificOutput;
    return isRecord(specific) ? stringField(specific, "additionalContext") : null;
  }
  return { executable: configuration.executable, storePath, verifyStore, readBead, readGates, readPrime, knownSecretValues: () => [...secrets] };
}

// packages/workflow-cli/src/adapters/git.ts
import { realpathSync as realpathSync2 } from "fs";
async function gitTopLevel(cwd) {
  const result = await runBounded(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.status !== "exited" || result.exit !== 0)
    return null;
  const top = result.stdout.trim();
  if (top.length === 0)
    return null;
  try {
    return realpathSync2(top);
  } catch {
    return null;
  }
}

// packages/workflow-cli/src/adapters/recovery.ts
import { lstatSync as lstatSync3 } from "fs";

// packages/workflow-cli/src/closed-json.ts
class ClosedJsonError extends Error {
}
var PROTO_KEY = "__proto__";
var JSON_SPACE = new Set([" ", "\t", `
`, "\r"]);

class Parser {
  text;
  index = 0;
  numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  constructor(text) {
    this.text = text;
  }
  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.text.length)
      this.fail("trailing content");
    return value;
  }
  value() {
    this.space();
    const character = this.text[this.index];
    if (character === "{")
      return this.object();
    if (character === "[")
      return this.array();
    if (character === '"')
      return this.string();
    if (character === "t")
      return this.literal("true", true);
    if (character === "f")
      return this.literal("false", false);
    if (character === "n")
      return this.literal("null", null);
    if (character === "-" || character !== undefined && character >= "0" && character <= "9")
      return this.number();
    return this.fail("expected a JSON value");
  }
  object() {
    this.index += 1;
    const result = {};
    const keys = new Set;
    this.space();
    if (this.take("}"))
      return result;
    for (;; ) {
      this.space();
      if (this.text[this.index] !== '"')
        this.fail("expected an object key");
      const key = this.string();
      if (keys.has(key))
        this.fail(`duplicate object key ${JSON.stringify(key)}`);
      if (key === PROTO_KEY)
        this.fail(`unsafe object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.space();
      if (!this.take(":"))
        this.fail("expected ':' after an object key");
      result[key] = this.value();
      this.space();
      if (this.take("}"))
        return result;
      if (!this.take(","))
        this.fail("expected ',' or '}' in an object");
    }
  }
  array() {
    this.index += 1;
    const result = [];
    this.space();
    if (this.take("]"))
      return result;
    for (;; ) {
      result.push(this.value());
      this.space();
      if (this.take("]"))
        return result;
      if (!this.take(","))
        this.fail("expected ',' or ']' in an array");
    }
  }
  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (!escaped && code === 34) {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          return this.fail("invalid JSON string");
        }
      }
      if (!escaped && code < 32)
        this.fail("unescaped control character in a string");
      if (!escaped && code === 92)
        escaped = true;
      else
        escaped = false;
      this.index += 1;
    }
    return this.fail("unterminated JSON string");
  }
  number() {
    this.numberPattern.lastIndex = this.index;
    const match = this.numberPattern.exec(this.text);
    if (match === null)
      return this.fail("invalid JSON number");
    this.index = this.numberPattern.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value))
      return this.fail("non-finite JSON number");
    return value;
  }
  literal(spelling, value) {
    if (!this.text.startsWith(spelling, this.index))
      return this.fail(`invalid JSON literal`);
    this.index += spelling.length;
    return value;
  }
  space() {
    while (JSON_SPACE.has(this.text[this.index] ?? ""))
      this.index += 1;
  }
  take(character) {
    if (this.text[this.index] !== character)
      return false;
    this.index += 1;
    return true;
  }
  fail(message) {
    throw new ClosedJsonError(`${message} at byte ${Buffer.byteLength(this.text.slice(0, this.index), "utf8")}`);
  }
}
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ClosedJsonError("input is not strict UTF-8");
  }
}
function parseClosedJson(text) {
  return new Parser(text).parse();
}
function parseClosedJsonBytes(bytes, limit) {
  if (bytes.byteLength > limit)
    throw new ClosedJsonError(`input exceeds ${limit} bytes`);
  return parseClosedJson(decodeUtf8(bytes));
}

// packages/workflow-cli/src/compaction-marker.ts
var MARKER_LIMIT_BYTES = 64 * 1024;
var RETAINED_SETTLED = 16;

class MarkerSchemaError extends Error {
}
var STATES = ["pending", "claimed", "delivered", "notified"];
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableString(value) {
  return value === null || typeof value === "string";
}
function parseGeneration(value) {
  if (!isRecord2(value))
    throw new MarkerSchemaError("generation must be one object");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "claimedAt,claimedBy,generation,recordedAt,settledAt,state")
    throw new MarkerSchemaError("generation fields do not match marker schema v1");
  if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 1)
    throw new MarkerSchemaError("generation must be a positive integer");
  if (!STATES.includes(value.state))
    throw new MarkerSchemaError("generation state is unknown");
  if (typeof value.recordedAt !== "string" || !nullableString(value.claimedAt) || !nullableString(value.claimedBy) || !nullableString(value.settledAt))
    throw new MarkerSchemaError("generation timestamps are invalid");
  return value;
}
function emptyMarker(sessionIdentity) {
  return { schemaVersion: 1, sessionIdentity, generations: [] };
}
function parseMarker(value, sessionIdentity) {
  if (!isRecord2(value))
    throw new MarkerSchemaError("marker must be one object");
  if (Object.keys(value).sort().join(",") !== "generations,schemaVersion,sessionIdentity")
    throw new MarkerSchemaError("marker fields do not match marker schema v1");
  if (value.schemaVersion !== 1)
    throw new MarkerSchemaError("marker schemaVersion must be 1");
  if (value.sessionIdentity !== sessionIdentity)
    throw new MarkerSchemaError("marker belongs to another session");
  if (!Array.isArray(value.generations))
    throw new MarkerSchemaError("marker generations must be an array");
  const generations = value.generations.map(parseGeneration);
  for (let index = 1;index < generations.length; index += 1) {
    if ((generations[index]?.generation ?? 0) <= (generations[index - 1]?.generation ?? 0))
      throw new MarkerSchemaError("marker generations must be strictly increasing");
  }
  return { schemaVersion: 1, sessionIdentity, generations };
}
function bounded2(generations) {
  const settled = generations.filter((generation) => generation.state === "delivered" || generation.state === "notified");
  const drop = new Set(settled.slice(0, Math.max(0, settled.length - RETAINED_SETTLED)).map((generation) => generation.generation));
  return generations.filter((generation) => !drop.has(generation.generation));
}
function recordGeneration(marker, now) {
  const last = marker.generations.at(-1)?.generation ?? 0;
  const generation = last + 1;
  return { marker: { ...marker, generations: bounded2([...marker.generations, { generation, state: "pending", recordedAt: now, claimedAt: null, claimedBy: null, settledAt: null }]) }, generation };
}
function claimForPrompt(marker, runIdentity, now) {
  const uncertain = marker.generations.filter((generation) => generation.state === "claimed").map((generation) => generation.generation);
  if (uncertain.length > 0) {
    const folded = marker.generations.filter((generation) => generation.state === "pending").map((generation) => generation.generation);
    const generations2 = marker.generations.map((generation) => generation.state === "claimed" || generation.state === "pending" ? { ...generation, state: "notified", settledAt: now } : generation);
    return { kind: "notice", uncertain, folded, marker: { ...marker, generations: bounded2(generations2) } };
  }
  const pending = marker.generations.filter((generation) => generation.state === "pending").map((generation) => generation.generation);
  if (pending.length === 0)
    return { kind: "silent" };
  const generations = marker.generations.map((generation) => generation.state === "pending" ? { ...generation, state: "claimed", claimedAt: now, claimedBy: runIdentity } : generation);
  return { kind: "deliver", claimed: pending, marker: { ...marker, generations } };
}
function recordDelivered(marker, claimed, now) {
  const set = new Set(claimed);
  return { ...marker, generations: bounded2(marker.generations.map((generation) => set.has(generation.generation) && generation.state === "claimed" ? { ...generation, state: "delivered", settledAt: now } : generation)) };
}
function summarizeMarker(marker) {
  const of = (state) => marker.generations.filter((generation) => generation.state === state).map((generation) => generation.generation);
  return { pending: of("pending"), uncertain: of("claimed"), delivered: of("delivered").length, notified: of("notified").length };
}

// packages/workflow-cli/src/recovery.ts
var BINDING_LIMIT_BYTES = 16 * 1024;
var SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
var FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000;
var STALE_AGE_MILLISECONDS = 60 * 60 * 1000;
var COMMENT_LIMIT_BYTES = 1024;
var COMMENT_COUNT = 3;
var PRIME_LIMIT_BYTES = 8 * 1024;
var BINDING_KEYS = ["schemaVersion", "sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "beadObservedAt", "sourceRepository", "evidencePath", "observedAt"];

class BindingSchemaError extends Error {
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value, maximum = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function isTimestamp(value) {
  if (typeof value !== "string")
    return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value);
}
function validateBinding(value, nowMilliseconds) {
  if (!isRecord3(value))
    throw new BindingSchemaError("binding must be one object");
  const keys = Object.keys(value).sort();
  const expected = [...BINDING_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new BindingSchemaError("binding fields do not match schema v3");
  if (value.schemaVersion !== 3)
    throw new BindingSchemaError("binding schemaVersion must be 3");
  for (const key of ["sessionIdentity", "workspace", "storePath", "storePrefix", "beadsExecutable", "beadsVersion", "beadId", "sourceRepository"]) {
    if (!boundedString(value[key]))
      throw new BindingSchemaError(`binding ${key} must be a nonempty bounded string`);
  }
  if (!SESSION_PATTERN.test(value.sessionIdentity))
    throw new BindingSchemaError("binding sessionIdentity is invalid");
  if (value.evidencePath !== null && !boundedString(value.evidencePath))
    throw new BindingSchemaError("binding evidencePath must be null or a nonempty bounded string");
  if (!isTimestamp(value.beadObservedAt))
    throw new BindingSchemaError("binding beadObservedAt must be a UTC RFC 3339 timestamp");
  if (!isTimestamp(value.observedAt))
    throw new BindingSchemaError("binding observedAt must be a UTC RFC 3339 timestamp");
  const observed = Date.parse(value.observedAt);
  if (observed - nowMilliseconds > FUTURE_SKEW_MILLISECONDS)
    throw new BindingSchemaError("binding observedAt is more than five minutes in the future");
  return { binding: value, stale: nowMilliseconds - observed > STALE_AGE_MILLISECONDS };
}
function sameOwner(saved, next) {
  return saved.workspace === next.workspace && saved.beadId === next.beadId && saved.sessionIdentity === next.sessionIdentity;
}
function truncateBytes(text, limit) {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= limit)
    return text;
  return `${new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, limit)).replace(/\uFFFD$/u, "")}\u2026`;
}
function openBlockers(bead) {
  return bead.dependencies.filter((dependency) => dependency.dependencyType === "blocks" && dependency.issueType !== "gate" && dependency.status !== "closed").map((dependency) => `${dependency.id} (${dependency.status}) ${dependency.title}`);
}
function openHumanGates(bead, gates) {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  return bead.dependencies.filter((dependency) => dependency.issueType === "gate").map((dependency) => byId.get(dependency.id) ?? { id: dependency.id, title: dependency.title, status: dependency.status, awaitType: dependency.awaitType }).filter((gate) => gate.awaitType === "human" && gate.status !== "closed").map((gate) => `${gate.id} (${gate.status}) ${gate.title}`);
}
function nextSafeAction(bead, blockers, gates) {
  if (gates.length > 0)
    return `Wait for the open human Gate ${gates[0]?.split(" ")[0] ?? ""} to close through native bd before continuing ${bead.id}; do not resolve it yourself`;
  if (blockers.length > 0)
    return `Resolve or wait for the open blocker ${blockers[0]?.split(" ")[0] ?? ""} through native bd before continuing ${bead.id}`;
  if (bead.status === "closed")
    return `${bead.id} is closed; bind this session to the next Bead with msb-workflow bind before doing more work`;
  if (bead.status === "in_progress")
    return `Continue ${bead.id} from the evidence pointer and the last comment; record the next checkpoint with native bd comment before compaction`;
  return `Claim ${bead.id} through native bd before starting work; the binding records intent, not a claim`;
}
var SHELL_SAFE = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;
function shellQuote(value) {
  return SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
function readOnlyCommands(binding) {
  const prefix = `BEADS_DIR=${shellQuote(binding.storePath)} ${shellQuote(binding.beadsExecutable)}`;
  return [
    `${prefix} show ${shellQuote(binding.beadId)} --readonly --json --include-comments`,
    `${prefix} gate list --all --readonly --json`,
    `${prefix} where --readonly --json`,
    `msb-workflow recover --workspace ${shellQuote(binding.workspace)} --session ${shellQuote(binding.sessionIdentity)} --json`
  ];
}
function buildPanel(inputs) {
  const { binding, bead } = inputs;
  const blockers = openBlockers(bead);
  const gates = openHumanGates(bead, inputs.gates);
  const comments = bead.comments.slice(-COMMENT_COUNT).map((comment) => ({ author: comment.author, createdAt: comment.createdAt, text: truncateBytes(comment.text, COMMENT_LIMIT_BYTES) }));
  const changedSinceBinding = bead.updatedAt !== null && bead.updatedAt !== binding.beadObservedAt;
  const action = nextSafeAction(bead, blockers, gates);
  const commands = readOnlyCommands(binding);
  const lines = [
    "# Resume Panel",
    `Session: ${binding.sessionIdentity}`,
    `Workspace: ${binding.workspace}`,
    `Store: ${inputs.store.storePath} (prefix ${inputs.store.prefix})`,
    `Beads executable: ${inputs.store.executable} (${inputs.store.version}; sha256 ${inputs.store.executableDigest})`,
    `Bead: ${bead.id} ${bead.title}`,
    `Status: ${bead.status}; assignee: ${bead.assignee ?? "unassigned"}; parent: ${bead.parent ?? "none"}; labels: ${bead.labels.length === 0 ? "none" : bead.labels.join(", ")}`,
    `Spec: ${bead.specId ?? "none"}; external ref: ${bead.externalRef ?? "none"}`,
    `Open blockers: ${blockers.length === 0 ? "none" : blockers.join("; ")}`,
    `Open human gates: ${gates.length === 0 ? "none" : gates.join("; ")}`,
    `Recent comments (last ${COMMENT_COUNT}, ${COMMENT_LIMIT_BYTES} bytes each):`,
    ...comments.length === 0 ? ["- none"] : comments.map((comment) => `- [${comment.author} ${comment.createdAt}] ${comment.text.replace(/\r?\n/g, " ")}`),
    `Evidence: ${binding.evidencePath ?? "none"}`,
    `Binding: observed ${binding.observedAt} (${inputs.stale ? "stale" : "fresh"}); Bead updated ${bead.updatedAt ?? "unknown"}; changed since binding: ${changedSinceBinding ? "yes" : "no"}`,
    "Read-only commands you may run:",
    ...commands.map((command) => `- ${command}`),
    "Recovered facts are hints; the current bd reads above are authoritative.",
    `Next safe action: ${action}`
  ];
  if (inputs.prime !== null)
    lines.push("", "## Beads prime context", truncateBytes(inputs.prime, PRIME_LIMIT_BYTES));
  const resumePanel = lines.join(`
`);
  const facts = {
    session: binding.sessionIdentity,
    workspace: binding.workspace,
    store: { path: inputs.store.storePath, prefix: inputs.store.prefix, executable: inputs.store.executable, executableDigest: inputs.store.executableDigest, version: inputs.store.version },
    bead: { id: bead.id, title: bead.title, status: bead.status, assignee: bead.assignee, parent: bead.parent, labels: [...bead.labels], specId: bead.specId, externalRef: bead.externalRef, updatedAt: bead.updatedAt },
    openBlockers: [...blockers],
    openHumanGates: [...gates],
    recentComments: comments,
    evidencePath: binding.evidencePath,
    binding: { observedAt: binding.observedAt, freshness: inputs.stale ? "stale" : "fresh", beadObservedAt: binding.beadObservedAt, changedSinceBinding },
    readOnlyCommands: [...commands],
    nextSafeAction: action,
    resumePanel
  };
  return { facts, resumePanel, nextSafeAction: action };
}

// packages/workflow-cli/src/runtime.ts
import { createHash as createHash2, randomUUID } from "crypto";
import { closeSync as closeSync3, constants as constants3, existsSync, fstatSync as fstatSync3, fsyncSync as fsyncSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, openSync as openSync3, readFileSync as readFileSync2, renameSync, unlinkSync as unlinkSync2, writeFileSync } from "fs";
import { dirname, isAbsolute as isAbsolute3, join as join3, resolve, sep as sep2 } from "path";
class RuntimeFailure extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
var HELPER_SEGMENTS = ["my-second-brain-playground", "workflow-cli"];
function identityKey(identity) {
  return createHash2("sha256").update(identity).digest("hex");
}
function stateAddresses(stateHome) {
  const helper = join3(stateHome, ...HELPER_SEGMENTS);
  const sessions = join3(helper, "recovery", "sessions");
  const locks = join3(helper, "locks");
  return {
    helper,
    sessions,
    diagnostics: join3(helper, "diagnostics"),
    binding: (sessionIdentity) => join3(sessions, `${sessionIdentity}.json`),
    marker: (sessionIdentity) => join3(sessions, `${sessionIdentity}.marker.json`),
    workspaceLock: (workspace) => join3(locks, "workspaces", `${identityKey(workspace).slice(0, 32)}.lock`),
    sessionLock: (sessionIdentity) => join3(locks, "sessions", `${identityKey(sessionIdentity).slice(0, 32)}.lock`)
  };
}
function currentUid2() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}
function assertOwned(stat, path) {
  const uid = currentUid2();
  if (uid !== null && stat.uid !== uid)
    throw new RuntimeFailure("unsafe", `${path} is not owned by the effective user`);
}
function assertDirectory(path) {
  let stat;
  try {
    stat = lstatSync2(path);
  } catch {
    throw new RuntimeFailure("unavailable", `${path} is not accessible`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new RuntimeFailure("unsafe", `${path} is not a real directory`);
  assertOwned(stat, path);
  if ((stat.mode & 511) !== 448)
    throw new RuntimeFailure("unsafe", `${path} must have mode 0700`);
}
function ensurePrivateDirectory(stateHome, path) {
  if (!isAbsolute3(stateHome) || stateHome.length === 0)
    throw new RuntimeFailure("unsafe", "the configured state root must be a nonempty absolute path");
  const root = resolve(stateHome);
  const target = resolve(path);
  if (target === root || !target.startsWith(`${root}${sep2}`))
    throw new RuntimeFailure("unsafe", "private state path escaped the selected state root");
  let rootStat;
  try {
    rootStat = lstatSync2(root);
  } catch {
    throw new RuntimeFailure("unavailable", `${root} is not accessible`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new RuntimeFailure("unsafe", `${root} is not a real directory`);
  assertOwned(rootStat, root);
  let current = root;
  for (const segment of target.slice(root.length + 1).split(sep2)) {
    current = join3(current, segment);
    if (!existsSync(current))
      mkdirSync2(current, { mode: 448 });
    assertDirectory(current);
  }
}
function assertPrivateAncestors(stateHome, path) {
  const root = resolve(stateHome);
  const target = resolve(path);
  if (!target.startsWith(`${root}${sep2}`))
    throw new RuntimeFailure("unsafe", "private state path escaped the selected state root");
  let current = root;
  for (const segment of target.slice(root.length + 1).split(sep2)) {
    current = join3(current, segment);
    assertDirectory(current);
  }
}
function assertPrivateFile(path, expected) {
  let named;
  try {
    named = lstatSync2(path);
  } catch {
    throw new RuntimeFailure("unavailable", `${path} is not accessible`);
  }
  if (named.isSymbolicLink() || !named.isFile())
    throw new RuntimeFailure("unsafe", `${path} is not a real regular file`);
  assertOwned(named, path);
  if ((named.mode & 511) !== 384)
    throw new RuntimeFailure("unsafe", `${path} must have mode 0600`);
  if (named.nlink !== 1)
    throw new RuntimeFailure("unsafe", `${path} must have exactly one link`);
  if (expected !== undefined && (named.dev !== expected.dev || named.ino !== expected.ino))
    throw new RuntimeFailure("unsafe", `${path} changed identity during access`);
  return named;
}
function privateEntryExists(path) {
  try {
    return lstatSync2(path) !== undefined;
  } catch (error) {
    if (error.code === "ENOENT")
      return false;
    throw new RuntimeFailure("unavailable", `${path} is not accessible`);
  }
}
function assertPrivateDescriptor(path, opened, named, limit) {
  if (!opened.isFile())
    throw new RuntimeFailure("unsafe", `${path} is not a real regular file`);
  assertOwned(opened, path);
  if ((opened.mode & 511) !== 384)
    throw new RuntimeFailure("unsafe", `${path} must have mode 0600`);
  if (opened.nlink !== 1)
    throw new RuntimeFailure("unsafe", `${path} must have exactly one link`);
  if (opened.dev !== named.dev || opened.ino !== named.ino)
    throw new RuntimeFailure("unsafe", `${path} changed identity during access`);
  if (opened.size > limit)
    throw new RuntimeFailure("unsafe", `${path} exceeds ${limit} bytes`);
}
function privateReadFailure(path, error) {
  if (error instanceof RuntimeFailure)
    throw error;
  const code = error.code;
  throw new RuntimeFailure(code === "ELOOP" ? "unsafe" : "unavailable", `${path} could not be read${typeof code === "string" ? ` (${code})` : ""}`);
}
function readPrivateFile(path, limit) {
  if (!privateEntryExists(path))
    return null;
  const named = assertPrivateFile(path);
  let descriptor = null;
  try {
    descriptor = openSync3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW);
    const opened = fstatSync3(descriptor);
    assertPrivateDescriptor(path, opened, named, limit);
    const bytes = readFileSync2(descriptor);
    assertPrivateDescriptor(path, fstatSync3(descriptor), opened, limit);
    return bytes;
  } catch (error) {
    return privateReadFailure(path, error);
  } finally {
    if (descriptor !== null)
      closeSync3(descriptor);
  }
}
function atomicWritePrivate(stateHome, path, bytes, hooks = {}) {
  const directory = dirname(path);
  ensurePrivateDirectory(stateHome, directory);
  if (privateEntryExists(path))
    assertPrivateFile(path);
  const temporary = join3(directory, `.${path.slice(path.lastIndexOf(sep2) + 1)}.${randomUUID()}.tmp`);
  let descriptor = null;
  let visible = false;
  try {
    descriptor = openSync3(temporary, constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL | constants3.O_NOFOLLOW, 384);
    const opened = fstatSync3(descriptor);
    assertOwned(opened, temporary);
    if (!opened.isFile() || (opened.mode & 511) !== 384 || opened.nlink !== 1)
      throw new RuntimeFailure("unsafe", "temporary state file is unsafe");
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync2(descriptor);
    closeSync3(descriptor);
    descriptor = null;
    assertPrivateFile(temporary, opened);
    hooks.beforeReplace?.();
    renameSync(temporary, path);
    visible = true;
    assertPrivateFile(path);
    hooks.afterReplace?.();
    const directoryDescriptor = openSync3(directory, constants3.O_RDONLY | constants3.O_NOFOLLOW);
    try {
      fsyncSync2(directoryDescriptor);
    } finally {
      closeSync3(directoryDescriptor);
    }
  } catch (error) {
    if (error instanceof RuntimeFailure && !visible)
      throw error;
    const code = error.code;
    throw new RuntimeFailure(visible ? "uncertain" : "unavailable", `private state replacement failed${typeof code === "string" ? ` (${code})` : ""}`);
  } finally {
    if (descriptor !== null)
      closeSync3(descriptor);
    try {
      if (existsSync(temporary))
        unlinkSync2(temporary);
    } catch {}
  }
}
function lockFailure(error) {
  if (error instanceof LockFailure)
    throw new RuntimeFailure(error.kind, error.message);
  throw error;
}
async function withLocks(stateHome, adapter, workspace, sessionIdentity, action) {
  const addresses = stateAddresses(stateHome);
  const workspaceLock = addresses.workspaceLock(workspace);
  const sessionLock = addresses.sessionLock(sessionIdentity);
  ensurePrivateDirectory(stateHome, dirname(workspaceLock));
  ensurePrivateDirectory(stateHome, dirname(sessionLock));
  try {
    return await adapter.withExclusive(workspaceLock, async () => adapter.withExclusive(sessionLock, action));
  } catch (error) {
    return lockFailure(error);
  }
}
async function withSessionLock(stateHome, adapter, sessionIdentity, action) {
  const sessionLock = stateAddresses(stateHome).sessionLock(sessionIdentity);
  ensurePrivateDirectory(stateHome, dirname(sessionLock));
  try {
    return await adapter.withExclusive(sessionLock, action);
  } catch (error) {
    return lockFailure(error);
  }
}

// packages/workflow-cli/src/adapters/recovery.ts
function classify2(error) {
  if (error instanceof RuntimeFailure && error.kind === "unsafe")
    return { status: "unsafe", reason: error.message };
  return { status: "unavailable", reason: error instanceof Error ? error.message : "private state read failed" };
}
function lockFileCheck(path) {
  let stat;
  try {
    stat = lstatSync3(path);
  } catch (error) {
    return error.code === "ENOENT" ? { path, status: "absent", reason: null } : { path, status: "unsafe", reason: "not accessible" };
  }
  const uid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile())
    return { path, status: "unsafe", reason: "not a regular file" };
  if (stat.uid !== uid)
    return { path, status: "unsafe", reason: "not owned by the effective user" };
  if ((stat.mode & 511) !== 384)
    return { path, status: "unsafe", reason: "mode is not 0600" };
  if (stat.nlink !== 1)
    return { path, status: "unsafe", reason: "more than one link" };
  return { path, status: "safe", reason: null };
}
function createRecoveryStore(stateHome, lockAdapter, hooks = {}) {
  const addresses = stateAddresses(stateHome);
  const readPrivate = (path, limit) => {
    if (!privateEntryExists(addresses.sessions))
      return null;
    assertPrivateAncestors(stateHome, addresses.sessions);
    return readPrivateFile(path, limit);
  };
  return {
    stateHome,
    platform: lockAdapter.platform,
    bindingPath: addresses.binding,
    markerPath: addresses.marker,
    readBinding(sessionIdentity, nowMilliseconds) {
      let bytes;
      try {
        bytes = readPrivate(addresses.binding(sessionIdentity), BINDING_LIMIT_BYTES);
      } catch (error) {
        return classify2(error);
      }
      if (bytes === null)
        return { status: "absent" };
      try {
        const validated = validateBinding(parseClosedJsonBytes(bytes, BINDING_LIMIT_BYTES), nowMilliseconds);
        if (validated.binding.sessionIdentity !== sessionIdentity)
          return { status: "invalid", reason: "binding sessionIdentity does not match its address", bytes };
        return { status: "available", binding: validated.binding, stale: validated.stale, bytes };
      } catch (error) {
        return { status: "invalid", reason: error instanceof Error ? error.message : "binding schema is invalid", bytes };
      }
    },
    writeBinding(binding) {
      atomicWritePrivate(stateHome, addresses.binding(binding.sessionIdentity), `${JSON.stringify(binding)}
`, hooks.bindingWrite ?? {});
    },
    readMarker(sessionIdentity) {
      let bytes;
      try {
        bytes = readPrivate(addresses.marker(sessionIdentity), MARKER_LIMIT_BYTES);
      } catch (error) {
        return classify2(error);
      }
      if (bytes === null)
        return { status: "available", marker: emptyMarker(sessionIdentity) };
      try {
        return { status: "available", marker: parseMarker(parseClosedJsonBytes(bytes, MARKER_LIMIT_BYTES), sessionIdentity) };
      } catch (error) {
        return { status: "invalid", reason: error instanceof Error ? error.message : "marker schema is invalid" };
      }
    },
    writeMarker(marker) {
      atomicWritePrivate(stateHome, addresses.marker(marker.sessionIdentity), `${JSON.stringify(marker)}
`);
    },
    withLocks: (workspace, sessionIdentity, action) => withLocks(stateHome, lockAdapter, workspace, sessionIdentity, action),
    withSessionLock: (sessionIdentity, action) => withSessionLock(stateHome, lockAdapter, sessionIdentity, action),
    checkLockFiles: (workspace, sessionIdentity) => [lockFileCheck(addresses.workspaceLock(workspace)), lockFileCheck(addresses.sessionLock(sessionIdentity))]
  };
}

// packages/workflow-cli/src/adapters/native.ts
var PRODUCTION_BD_PIN = { executable: "/Users/nathanvale/.local/share/mise/installs/github-gastownhall-beads/1.3.0/bd", sha256: "86e81a32d7b7cf3309a343210fac65e5a5ac485102c604447bf37d45aac675f0" };
function stateRootIssue(configured) {
  if (configured.length === 0)
    return "the configured state root must be nonempty";
  if (!isAbsolute4(configured) || /[\0\r\n]/.test(configured))
    return "the configured state root must be an absolute path";
  let stat;
  try {
    stat = lstatSync4(configured);
  } catch (error) {
    return error.code === "ENOENT" ? "the configured state root does not exist" : "the configured state root is not accessible";
  }
  if (stat.isSymbolicLink())
    return "the configured state root must not be a symbolic link";
  if (!stat.isDirectory())
    return "the configured state root must be a directory";
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
    return "the configured state root must be owned by the effective user";
  return null;
}
function selectStateRoot(env) {
  const configured = env.MSB_WORKFLOW_STATE_HOME ?? env.XDG_STATE_HOME ?? join4(env.HOME ?? homedir(), ".local", "state");
  const issue = stateRootIssue(configured);
  return issue === null ? { status: "selected", path: configured } : { status: "refused", reason: issue };
}
function productionContext(env, cwd, options = {}) {
  const platform = options.platform ?? process.platform;
  return {
    runIdentity: `run-${randomUUID2()}`,
    cwd,
    env,
    platform,
    now: () => new Date,
    stateRoot: selectStateRoot(env),
    openStore: (stateHome) => createRecoveryStore(stateHome, lockAdapterFor(platform), options.storeHooks ?? {}),
    openBeads: (executable, workspace, processCwd) => createBeadsReader({ executable, workspace, cwd: processCwd, pin: PRODUCTION_BD_PIN }),
    gitTopLevel,
    openDiagnostics
  };
}

// packages/workflow-cli/src/branch-station-catalog.ts
var INSPECT = "msb-workflow.inspect";
var BIND = "msb-workflow.bind";
var RECOVER = "msb-workflow.recover";
var ROUTED = [INSPECT, BIND, RECOVER];
var READERS = [BIND, RECOVER];
var ALL = ["msb-workflow.help", "msb-workflow.discover", ...ROUTED, "msb-workflow.hook"];
var shared = (station, trigger, outcome, causeCode, transactionState, retryable, delay, guidance, identities) => identities.map((identity) => [station, identity, trigger, outcome, causeCode, transactionState, retryable, delay, guidance]);
var ROWS = [
  ["help-shown", "msb-workflow.help", "--help requested", "success", null, "unchanged", false, null, "none"],
  ["discovery-shown", "msb-workflow.discover", "--discover requested", "success", null, "unchanged", false, null, "none"],
  ...shared("usage-refused", "No arguments, unknown command, unknown option, a missing or malformed required option, or `hook` with any extra argument", "refused", "USAGE_INVALID_INVOCATION", "unchanged", false, null, "next-action", ALL),
  ...shared("state-root-refused", "The explicit state root is empty, relative, missing, a symlink, a non-directory, or owned by another user", "refused", "DOMAIN_STATE_ROOT_UNSAFE", "unchanged", false, null, "next-action", ROUTED),
  ...shared("workspace-refused", "--workspace is not an existing canonical absolute directory", "refused", "DOMAIN_WORKSPACE_INVALID", "unchanged", false, null, "next-action", ROUTED),
  ...shared("session-invalid", "The session token from --session or CODEX_SESSION_ID does not match the closed grammar", "refused", "DOMAIN_SESSION_INVALID", "unchanged", false, null, "next-action", ROUTED),
  ...shared("session-conflict", "--session and CODEX_SESSION_ID are both present and differ", "refused", "DOMAIN_SESSION_CONFLICT", "unchanged", false, null, "next-action", ROUTED),
  ...shared("internal-failure", "An unexpected exception before any durable write", "failed", "INTERNAL_UNEXPECTED", "unchanged", false, null, "handoff", ROUTED),
  ...shared("beads-unavailable", "A native bd read failed to start, timed out, returned no JSON, or returned an error value that names no absent Bead (no_beads_directory, contention, unclassified)", "failed", "UNAVAILABLE_BEADS_READ", "unchanged", true, 1000, "next-action", ROUTED),
  ...shared("executable-refused", "The bd executable named by MSB_WORKFLOW_BD_EXECUTABLE or the binding was not accepted: it must be exactly the pinned absolute canonical path, a regular executable file, and hash to the pinned SHA-256 before any bd read; unset, relative, another path, a symlink, missing, not executable, or another digest all refuse", "refused", "DOMAIN_EXECUTABLE_INVALID", "unchanged", false, null, "next-action", READERS),
  ...shared("store-mismatch", `bd version is not ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}, where.path is not <workspace>/.beads, the prefix disagrees with effective configuration, or context is redirected`, "refused", "DOMAIN_STORE_MISMATCH", "unchanged", false, null, "next-action", READERS),
  ...shared("state-unsafe", "A private state ancestor, lock file, marker, or binding has unsafe ownership, type, mode, link count, or identity", "refused", "DOMAIN_STATE_UNSAFE", "unchanged", false, null, "next-action", READERS),
  ...shared("binding-invalid", "The saved binding is not one bounded schema-v3 object: malformed bytes, duplicate keys, unknown or missing fields, null identities, or future skew", "refused", "SCHEMA_BINDING_INVALID", "unchanged", false, null, "next-action", READERS),
  ...shared("bead-missing", "The pinned bd reports the named Bead absent from the selected store", "refused", "DOMAIN_BEAD_MISSING", "unchanged", false, null, "next-action", READERS),
  ["inspected", INSPECT, "Every prerequisite passed: executable, store, state root, binding, marker and lock files", "success", null, "unchanged", false, null, "next-action"],
  ["inspect-refused", INSPECT, "At least one prerequisite failed; each failure and one repair are named in the result", "refused", "DOMAIN_PREREQUISITE_FAILED", "unchanged", false, null, "next-action"],
  ["source-repository-missing", BIND, "bind ran outside a Git working directory, so sourceRepository cannot be derived", "refused", "DOMAIN_SOURCE_REPOSITORY_MISSING", "unchanged", false, null, "next-action"],
  ["evidence-invalid", BIND, "--evidence is not a canonical regular file inside sourceRepository", "refused", "DOMAIN_EVIDENCE_INVALID", "unchanged", false, null, "next-action"],
  ["binding-owner-conflict", BIND, "A saved binding for this session names a different Bead or workspace; the saved bytes are preserved", "refused", "DOMAIN_BINDING_OWNERSHIP_CONFLICT", "unchanged", false, null, "next-action"],
  ["binding-inherited-conflict", BIND, "The session came only from CODEX_SESSION_ID and a saved binding names a different owner; an inherited identity is not worker ownership", "refused", "DOMAIN_SESSION_INHERITED_CONFLICT", "unchanged", false, null, "next-action"],
  ["storage-busy", BIND, "A cooperating process held the workspace or session flock for the complete 2,000 ms bound", "failed", "UNAVAILABLE_STORAGE_BUSY", "unchanged", true, 2000, "next-action"],
  ["platform-unsupported", BIND, "The selected platform has no admitted process-lock Adapter", "failed", "UNAVAILABLE_LOCK_UNSUPPORTED", "unchanged", false, null, "next-action"],
  ["write-failed", BIND, "The binding write failed before the rename became visible; nothing changed", "failed", "UNAVAILABLE_WRITE_FAILED", "unchanged", true, null, "next-action"],
  ["write-unknown", BIND, "The binding write failed after the rename became visible; the durable state is unknown until recover reads it", "unknown", "INTERNAL_WRITE_OUTCOME_UNKNOWN", "unknown", false, null, "next-action"],
  ["bound", BIND, "The binding was written or the same owner refreshed", "success", null, "completed", false, null, "next-action"],
  ["recovered", RECOVER, "The binding was read, every native read agreed, and the Resume Panel was built from current facts", "success", null, "unchanged", false, null, "next-action"],
  ["binding-absent", RECOVER, "No binding exists for the selected session", "refused", "DOMAIN_BINDING_ABSENT", "unchanged", false, null, "next-action"],
  ["binding-workspace-mismatch", RECOVER, "The stored workspace differs from --workspace", "refused", "DOMAIN_BINDING_WORKSPACE_MISMATCH", "unchanged", false, null, "next-action"]
];
function failureClassOf(causeCode) {
  if (causeCode === null)
    return null;
  const prefix = causeCode.slice(0, causeCode.indexOf("_")).toLowerCase();
  if (prefix === "usage" || prefix === "domain" || prefix === "schema" || prefix === "internal" || prefix === "unavailable")
    return prefix;
  throw new Error(`cause code without a failure-class prefix: ${causeCode}`);
}
function toStation(row) {
  const [station, commandIdentity, trigger, outcome, causeCode, transactionState, retryable, retryDelayMilliseconds, guidance] = row;
  const failureClass = failureClassOf(causeCode);
  return { station, commandIdentity, trigger, outcome, failureClass, causeCode, effectClass: commandDeclaration(commandIdentity).effectClass, transactionState, retryable, retryDelayMilliseconds, guidance, exit: exitFor(failureClass) };
}
function stationKey(observation) {
  return `${observation.commandIdentity}#${observation.station}`;
}
var BY_KEY = (() => {
  const map = new Map;
  for (const row of ROWS) {
    const station = toStation(row);
    const key = stationKey(station);
    if (map.has(key))
      throw new Error(`duplicate station declaration: ${key}`);
    map.set(key, station);
  }
  return map;
})();
var STATIONS = [...BY_KEY.values()];
function stationFor(observation) {
  const station = BY_KEY.get(stationKey(observation));
  if (station === undefined)
    throw new Error(`undeclared branch station: ${stationKey(observation)}`);
  return station;
}

// packages/workflow-cli/src/commands/bind.ts
import { lstatSync as lstatSync5, realpathSync as realpathSync4 } from "fs";
import { isAbsolute as isAbsolute6, relative, sep as sep3 } from "path";

// packages/workflow-cli/src/commands/shared.ts
import { existsSync as existsSync2, realpathSync as realpathSync3, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute5, join as join5 } from "path";
function refusal(station, message, repairAction, nextAction, result = {}) {
  return { station, message, result: { station, ...result }, repairAction, nextAction, availablePaths: [], handoffPrerequisites: [] };
}
function success(station, message, result, nextAction) {
  return { station, message, result: { station, ...result }, repairAction: null, nextAction, availablePaths: [], handoffPrerequisites: [] };
}
function internalFailure() {
  return { station: "internal-failure", message: "unexpected internal failure before any durable write", result: { station: "internal-failure" }, repairAction: "Report the run identity to the helper owner; nothing was written", nextAction: null, availablePaths: [], handoffPrerequisites: ["Inspect the workspace and session with msb-workflow inspect", "Report the run identity to the helper owner"] };
}
function resolveSession(explicit, env) {
  const inherited = env.CODEX_SESSION_ID !== undefined && env.CODEX_SESSION_ID.length > 0 ? env.CODEX_SESSION_ID : null;
  if (explicit !== null && inherited !== null && explicit !== inherited)
    return { status: "conflict" };
  const value = explicit ?? inherited;
  if (value === null)
    return { status: "missing" };
  if (!SESSION_PATTERN.test(value))
    return { status: "invalid", value };
  return { status: "resolved", session: value, source: explicit !== null ? "explicit" : "environment" };
}
function sessionOutcome(resolution) {
  if (resolution.status === "conflict")
    return refusal("session-conflict", "--session and CODEX_SESSION_ID disagree", "Pass the session identity of this Harness session once, through --session or CODEX_SESSION_ID, not two different values", HELP_ACTION);
  if (resolution.status === "invalid")
    return refusal("session-invalid", "the session token does not match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", "Pass the Harness session identity exactly as the Harness reports it", HELP_ACTION);
  return refusal("usage-refused", "--session or CODEX_SESSION_ID is required", `Pass --session <id> or export CODEX_SESSION_ID, then repeat the command; see ${HELP_ACTION}`, HELP_ACTION);
}
function canonicalWorkspace(workspace) {
  if (!isAbsolute5(workspace) || /[\0\r\n]/.test(workspace))
    return null;
  try {
    const real = realpathSync3(workspace);
    return real === workspace && statSync3(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
function workspaceOutcome(workspace) {
  return refusal("workspace-refused", `workspace ${workspace} is not an existing canonical absolute directory`, "Pass the canonical absolute path of the directory whose .beads store is selected", HELP_ACTION, { workspace });
}
function stateRootOutcome(reason) {
  return refusal("state-root-refused", reason, "Configure MSB_WORKFLOW_STATE_HOME (or XDG_STATE_HOME) as one existing absolute directory you own, then repeat the command", HELP_ACTION);
}
function isGitRepository(cwd) {
  let current = cwd;
  for (;; ) {
    if (existsSync2(join5(current, ".git")))
      return true;
    const parent = join5(current, "..");
    if (realpathSafe(parent) === realpathSafe(current))
      return false;
    current = parent;
  }
}
function realpathSafe(path) {
  try {
    return realpathSync3(path);
  } catch {
    return path;
  }
}
function storeOutcome(read2, workspace) {
  if (read2.status === "verified")
    return null;
  if (read2.status === "executable-invalid")
    return refusal("executable-refused", read2.reason, `Set MSB_WORKFLOW_BD_EXECUTABLE to the absolute path of the pinned bd ${PINNED_BD_VERSION} executable and bind again`, `msb-workflow inspect --workspace ${workspace}`, { reason: read2.reason });
  if (read2.status === "mismatch")
    return refusal("store-mismatch", read2.reason, `Select the workspace whose .beads store is the intended one and the pinned bd ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}; a wrong, empty, global, or redirected store is never adopted`, `msb-workflow inspect --workspace ${workspace}`, { reason: read2.reason });
  return { station: "beads-unavailable", message: read2.reason, result: { station: "beads-unavailable", reason: read2.reason }, repairAction: "Check that the selected .beads store exists and no other bd process holds it, then retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace}`, availablePaths: [], handoffPrerequisites: [] };
}
function beadOutcome(read2, beadId, workspace) {
  if (read2.status === "found")
    return null;
  if (read2.status === "missing")
    return refusal("bead-missing", `Bead ${beadId} is not in the selected store: ${read2.reason}`, `Check the Bead identifier ${beadId} with BEADS_DIR=${join5(workspace, ".beads")} bd list --readonly --json, then bind the correct one`, `msb-workflow inspect --workspace ${workspace}`, { beadId, reason: read2.reason });
  return { station: "beads-unavailable", message: read2.reason, result: { station: "beads-unavailable", reason: read2.reason, beadId }, repairAction: "Check that the selected .beads store exists and no other bd process holds it, then retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace}`, availablePaths: [], handoffPrerequisites: [] };
}
function unavailableOutcome(reason, workspace) {
  return { station: "beads-unavailable", message: reason, result: { station: "beads-unavailable", reason }, repairAction: "Check that the selected .beads store exists and no other bd process holds it, then retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace}`, availablePaths: [], handoffPrerequisites: [] };
}
function stateUnsafeOutcome(reason, workspace) {
  return refusal("state-unsafe", reason, "Repair the named private state entry (owner, mode 0600/0700, no symlink, one link) or remove it, then repeat the command", `msb-workflow inspect --workspace ${workspace}`, { reason });
}
function bindingInvalidOutcome(reason, path, workspace, session) {
  return refusal("binding-invalid", `saved binding is not schema v3: ${reason}`, `Move or delete ${path} after reading it, then bind again; the helper never rewrites a malformed binding`, `msb-workflow bind --workspace ${workspace} --bead <bead-id> --session ${session}`, { reason, bindingPath: path });
}

// packages/workflow-cli/src/commands/bind.ts
function canonicalEvidence(evidence, sourceRepository) {
  if (evidence === null)
    return { status: "ok", path: null };
  if (!isAbsolute6(evidence) || /[\0\r\n]/.test(evidence))
    return { status: "invalid", reason: "--evidence must be an absolute path" };
  try {
    const stat = lstatSync5(evidence);
    if (stat.isSymbolicLink() || !stat.isFile())
      return { status: "invalid", reason: "--evidence must be a regular file, not a symlink or directory" };
    if (realpathSync4(evidence) !== evidence)
      return { status: "invalid", reason: "--evidence must be canonical (no symlinks in any segment)" };
  } catch {
    return { status: "invalid", reason: "--evidence does not exist or is not readable" };
  }
  const fromRepository = relative(sourceRepository, evidence);
  if (fromRepository === "" || fromRepository.startsWith(`..${sep3}`) || fromRepository === ".." || isAbsolute6(fromRepository))
    return { status: "invalid", reason: `--evidence must be inside the source repository ${sourceRepository}` };
  return { status: "ok", path: evidence };
}
function writeOutcome(error, workspace, session) {
  if (error instanceof RuntimeFailure && error.kind === "busy")
    return { station: "storage-busy", message: error.message, result: { station: "storage-busy", reason: error.message }, repairAction: "Another msb-workflow process holds this workspace or session lock; wait for it to finish and retry the same command", nextAction: `msb-workflow inspect --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] };
  if (error instanceof RuntimeFailure && error.kind === "unsupported")
    return { station: "platform-unsupported", message: error.message, result: { station: "platform-unsupported", reason: error.message }, repairAction: "Run the helper on macOS, the only platform with an admitted lock Adapter; a Linux flock Adapter is a later unit", nextAction: `msb-workflow inspect --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] };
  if (error instanceof RuntimeFailure && error.kind === "unsafe")
    return stateUnsafeOutcome(error.message, workspace);
  if (error instanceof RuntimeFailure && error.kind === "uncertain")
    return { station: "write-unknown", message: `the binding rename became visible but the write did not complete cleanly: ${error.message}`, result: { station: "write-unknown", reason: error.message }, repairAction: `Run msb-workflow recover --workspace ${workspace} --session ${session} to read the durable binding before deciding whether to bind again`, nextAction: `msb-workflow recover --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] };
  const reason = error instanceof Error ? error.message : "binding write failed";
  return { station: "write-failed", message: reason, result: { station: "write-failed", reason }, repairAction: "Repair the private state directory (owner, mode 0700, free space), then retry the same bind", nextAction: `msb-workflow inspect --workspace ${workspace} --session ${session}`, availablePaths: [], handoffPrerequisites: [] };
}
function lockedWrite(input) {
  const { store, binding } = input;
  const saved = store.readBinding(binding.sessionIdentity, Date.parse(binding.observedAt));
  if (saved.status === "unsafe")
    return { refusal: stateUnsafeOutcome(saved.reason, binding.workspace), refreshed: false };
  if (saved.status === "unavailable")
    throw new RuntimeFailure("unavailable", saved.reason);
  if (saved.status === "invalid")
    return { refusal: bindingInvalidOutcome(saved.reason, store.bindingPath(binding.sessionIdentity), binding.workspace, binding.sessionIdentity), refreshed: false };
  if (saved.status === "available" && !sameOwner(saved.binding, binding)) {
    input.diagnostics.log("binding.conflict", { savedBeadId: saved.binding.beadId, requestedBeadId: binding.beadId, sessionSource: input.source });
    const detail = `session ${binding.sessionIdentity} is bound to ${saved.binding.beadId} in ${saved.binding.workspace}; requested ${binding.beadId} in ${binding.workspace}`;
    if (input.source === "environment")
      return { refusal: refusal("binding-inherited-conflict", `inherited session identity cannot replace a saved owner: ${detail}`, "An inherited CODEX_SESSION_ID is not worker ownership. Verify your own Harness session identity and pass it with --session; the saved binding is preserved", `msb-workflow recover --workspace ${saved.binding.workspace} --session ${binding.sessionIdentity}`, { savedBeadId: saved.binding.beadId, savedWorkspace: saved.binding.workspace }), refreshed: false };
    return { refusal: refusal("binding-owner-conflict", `saved binding names a different owner: ${detail}`, "Recover the saved binding and continue that Bead, or use a different session for the new Bead; no flag replaces a saved owner and a deliberate task switch is a later verified protocol", `msb-workflow recover --workspace ${saved.binding.workspace} --session ${binding.sessionIdentity}`, { savedBeadId: saved.binding.beadId, savedWorkspace: saved.binding.workspace }), refreshed: false };
  }
  store.writeBinding(binding);
  return { refusal: null, refreshed: saved.status === "available" };
}
async function readOwner(beads, request) {
  const storeRead = await beads.verifyStore(true);
  if (storeRead.status !== "verified")
    return storeOutcome(storeRead, request.workspace) ?? unavailableOutcome("store did not verify", request.workspace);
  const beadRead = await beads.readBead(request.beadId);
  if (beadRead.status !== "found")
    return beadOutcome(beadRead, request.beadId, request.workspace) ?? unavailableOutcome("Bead did not read", request.workspace);
  const gates = await beads.readGates();
  if (gates.status === "unavailable")
    return unavailableOutcome(gates.reason, request.workspace);
  return { store: storeRead.store, bead: beadRead.bead, gates: gates.gates };
}
function isOutcome(value) {
  return "station" in value;
}
async function prepare(request, context) {
  const session = resolveSession(request.session, context.env);
  if (session.status !== "resolved")
    return sessionOutcome(session);
  const sourceRepository = await context.gitTopLevel(context.cwd);
  const again = `msb-workflow bind --workspace ${request.workspace} --bead ${request.beadId} --session ${session.session}`;
  if (sourceRepository === null)
    return refusal("source-repository-missing", "bind must run inside a Git working directory; sourceRepository is derived from its top level", "Change into the source repository that owns this work (a worktree is fine) and bind again; there is no --source flag", `cd <source-repository> && ${again}`);
  const evidence = canonicalEvidence(request.evidence, sourceRepository);
  if (evidence.status === "invalid")
    return refusal("evidence-invalid", evidence.reason, `Pass --evidence as the canonical absolute path of a regular file inside ${sourceRepository}, or omit it`, again);
  return { session: session.session, source: session.source, sourceRepository, evidencePath: evidence.path };
}
function bindingFor(request, prepared, owner, now) {
  return {
    schemaVersion: 3,
    sessionIdentity: prepared.session,
    workspace: request.workspace,
    storePath: owner.store.storePath,
    storePrefix: owner.store.prefix,
    beadsExecutable: owner.store.executable,
    beadsVersion: owner.store.version,
    beadId: request.beadId,
    beadObservedAt: owner.bead.updatedAt ?? now,
    sourceRepository: prepared.sourceRepository,
    evidencePath: prepared.evidencePath,
    observedAt: now
  };
}
async function runBind(request, context, stateHome, diagnostics) {
  const prepared = await prepare(request, context);
  if ("station" in prepared)
    return { outcome: prepared, knownSecretValues: [] };
  const beads = context.openBeads(context.env.MSB_WORKFLOW_BD_EXECUTABLE ?? "", request.workspace, context.cwd);
  const secrets = () => beads.knownSecretValues();
  const owner = await readOwner(beads, request);
  if (isOutcome(owner))
    return { outcome: owner, knownSecretValues: secrets() };
  const binding = bindingFor(request, prepared, owner, context.now().toISOString());
  const recoveryStore = context.openStore(stateHome);
  diagnostics.log("bind.started", { beadId: request.beadId, sessionSource: prepared.source, executableDigest: owner.store.executableDigest });
  let written;
  try {
    written = await recoveryStore.withLocks(request.workspace, prepared.session, async () => lockedWrite({ store: recoveryStore, binding, source: prepared.source, diagnostics }));
  } catch (error) {
    diagnostics.log("bind.failed", { kind: error instanceof RuntimeFailure ? error.kind : "unknown" });
    return { outcome: writeOutcome(error, request.workspace, prepared.session), knownSecretValues: secrets() };
  }
  if (written.refusal !== null)
    return { outcome: written.refusal, knownSecretValues: secrets() };
  const panel = buildPanel({ binding, stale: false, store: owner.store, bead: owner.bead, gates: owner.gates, prime: null });
  diagnostics.log("bind.completed", { beadId: request.beadId, refreshed: written.refreshed });
  const message = `binding ${written.refreshed ? "refreshed" : "written"} for ${prepared.session} -> ${request.beadId}`;
  return { outcome: success("bound", message, { bindingPath: recoveryStore.bindingPath(prepared.session), refreshed: written.refreshed, binding: { ...binding }, ...panel.facts }, panel.nextSafeAction), knownSecretValues: secrets() };
}

// packages/workflow-cli/src/commands/hook.ts
import { realpathSync as realpathSync5, statSync as statSync4 } from "fs";
import { isAbsolute as isAbsolute7, sep as sep4 } from "path";

// packages/workflow-cli/src/commands/recover.ts
async function readPanel(store, context, workspace, session, diagnostics, options) {
  const read2 = store.readBinding(session, context.now().getTime());
  const shown = workspace ?? "<workspace>";
  if (read2.status === "absent")
    return { status: "refused", outcome: refusal("binding-absent", `no binding exists for session ${session}`, `Bind this session first: msb-workflow bind --workspace ${shown} --bead <bead-id> --session ${session}`, `msb-workflow bind --workspace ${shown} --bead <bead-id> --session ${session}`, { bindingPath: store.bindingPath(session) }), beads: null };
  if (read2.status === "unsafe")
    return { status: "refused", outcome: stateUnsafeOutcome(read2.reason, shown), beads: null };
  if (read2.status === "unavailable")
    return { status: "refused", outcome: unavailableOutcome(read2.reason, shown), beads: null };
  if (read2.status === "invalid")
    return { status: "refused", outcome: bindingInvalidOutcome(read2.reason, store.bindingPath(session), shown, session), beads: null };
  const binding = read2.binding;
  if (workspace !== null && binding.workspace !== workspace)
    return { status: "refused", outcome: refusal("binding-workspace-mismatch", `session ${session} is bound to workspace ${binding.workspace}, not ${workspace}`, `Run recover with --workspace ${binding.workspace}, the workspace this session was bound to`, `msb-workflow recover --workspace ${binding.workspace} --session ${session}`, { boundWorkspace: binding.workspace }), beads: null };
  const beads = context.openBeads(binding.beadsExecutable, binding.workspace, context.cwd);
  const storeRead = await beads.verifyStore(isGitRepository(context.cwd));
  const storeRefusal = storeOutcome(storeRead, binding.workspace);
  if (storeRefusal !== null || storeRead.status !== "verified")
    return { status: "refused", outcome: storeRefusal ?? unavailableOutcome("store did not verify", binding.workspace), beads };
  const beadRead = await beads.readBead(binding.beadId);
  const beadRefusal = beadOutcome(beadRead, binding.beadId, binding.workspace);
  if (beadRefusal !== null || beadRead.status !== "found")
    return { status: "refused", outcome: beadRefusal ?? unavailableOutcome("Bead did not read", binding.workspace), beads };
  const gates = await beads.readGates();
  if (gates.status === "unavailable")
    return { status: "refused", outcome: unavailableOutcome(gates.reason, binding.workspace), beads };
  const prime = options.includePrime ? await beads.readPrime() : null;
  diagnostics.log("panel.built", { beadId: binding.beadId, stale: read2.stale, prime: prime !== null });
  return { status: "ready", panel: buildPanel({ binding, stale: read2.stale, store: storeRead.store, bead: beadRead.bead, gates: gates.gates, prime }), binding, beads };
}
async function runRecover(request, context, stateHome, diagnostics) {
  const session = resolveSession(request.session, context.env);
  if (session.status !== "resolved")
    return { outcome: sessionOutcome(session), knownSecretValues: [] };
  const store = context.openStore(stateHome);
  const read2 = await readPanel(store, context, request.workspace, session.session, diagnostics, { includePrime: false });
  const knownSecretValues = read2.beads?.knownSecretValues() ?? [];
  if (read2.status === "refused")
    return { outcome: read2.outcome, knownSecretValues };
  return { outcome: success("recovered", `Resume Panel for ${session.session} -> ${read2.binding.beadId}`, { bindingPath: store.bindingPath(session.session), ...read2.panel.facts }, read2.panel.nextSafeAction), knownSecretValues };
}

// packages/workflow-cli/src/commands/hook.ts
var HOOK_INPUT_LIMIT_BYTES = 128 * 1024;
var EVENTS = ["SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit"];
var SESSION_SOURCES = ["startup", "resume", "clear", "compact"];
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalDirectory(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\0\r\n]/.test(value) || !isAbsolute7(value))
    return null;
  try {
    return realpathSync5(value) === value && statSync4(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}
function parseEvent(bytes) {
  let parsed;
  try {
    parsed = parseClosedJsonBytes(bytes, HOOK_INPUT_LIMIT_BYTES);
  } catch {
    return null;
  }
  if (!isRecord4(parsed))
    return null;
  const event = parsed.hook_event_name;
  if (typeof event !== "string" || !EVENTS.includes(event))
    return null;
  let source = null;
  if (event === "SessionStart") {
    if (typeof parsed.source !== "string" || !SESSION_SOURCES.includes(parsed.source))
      return null;
    source = parsed.source;
  }
  const session = parsed.session_id;
  if (typeof session !== "string" || !SESSION_PATTERN.test(session))
    return null;
  const cwd = canonicalDirectory(parsed.cwd);
  if (cwd === null)
    return null;
  return { event, source, session, cwd };
}
function cwdAdmitted(cwd, binding) {
  const within = (root) => {
    try {
      const real = realpathSync5(root);
      return cwd === real || cwd.startsWith(`${real}${sep4}`);
    } catch {
      return false;
    }
  };
  try {
    if (cwd === realpathSync5(binding.workspace))
      return true;
  } catch {}
  return within(binding.sourceRepository);
}
function harnessJson(eventName, additionalContext) {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } })}
`;
}
function systemMessageJson(systemMessage) {
  return `${JSON.stringify({ systemMessage })}
`;
}
function guidance(binding) {
  return [
    "My Second Brain recovery session.",
    `Session identity: ${binding.sessionIdentity}`,
    `Bound to Bead ${binding.beadId} in ${binding.workspace} (store ${binding.storePath}).`,
    `Rebuild the Resume Panel at any time: msb-workflow recover --workspace ${shellQuote(binding.workspace)} --session ${shellQuote(binding.sessionIdentity)} --json`,
    `Refresh or rebind with this exact session identity: msb-workflow bind --workspace ${shellQuote(binding.workspace)} --bead <bead-id> --session ${shellQuote(binding.sessionIdentity)}`,
    "After compaction the Resume Panel is delivered once: on the next prompt (Codex) or at SessionStart compact (Claude Code)."
  ].join(`
`);
}
function notice(binding, uncertain, folded) {
  const foldedText = folded.length === 0 ? "" : ` Pending generation(s) ${folded.join(", ")} settle with this notice.`;
  return `msb-workflow: the Resume Panel for compaction generation(s) ${uncertain.join(", ")} was claimed but never recorded delivered; run msb-workflow recover --workspace ${shellQuote(binding.workspace)} --session ${shellQuote(binding.sessionIdentity)} --json to rebuild it.${foldedText} Nothing is replayed automatically.`;
}
var SILENT = { delivery: "silent", stdout: "" };
async function readPanelText(bound, eventName) {
  const read2 = await readPanel(bound.store, bound.context, null, bound.event.session, bound.diagnostics, { includePrime: true });
  if (read2.status === "refused") {
    bound.diagnostics.log("hook.read-failed", { level: "warning", station: read2.outcome.station });
    return null;
  }
  return harnessJson(eventName, redactText(read2.panel.resumePanel, read2.beads.knownSecretValues()));
}
async function sessionStart(bound) {
  if (bound.event.source !== "compact") {
    const text2 = harnessJson("SessionStart", guidance(bound.binding));
    bound.emit(text2);
    return { delivery: "session-guidance", stdout: text2 };
  }
  const text = await readPanelText(bound, "SessionStart");
  if (text === null)
    return SILENT;
  bound.emit(text);
  return { delivery: "compact-panel", stdout: text };
}
async function preCompact(bound) {
  const read2 = await readPanel(bound.store, bound.context, null, bound.event.session, bound.diagnostics, { includePrime: false });
  if (read2.status === "refused") {
    const secrets = read2.beads?.knownSecretValues() ?? [];
    const text = systemMessageJson(redactText(`msb-workflow recovery is unavailable before compaction: ${read2.outcome.message}. Repair: ${read2.outcome.repairAction ?? read2.outcome.nextAction ?? "msb-workflow inspect"}`, secrets));
    bound.emit(text);
    return { delivery: "precompact-unavailable", stdout: text };
  }
  return { delivery: "precompact-available", stdout: "" };
}
function withMarker(bound, whenUnreadable, action) {
  const { store, event } = bound;
  return store.withSessionLock(event.session, async () => {
    const marker = store.readMarker(event.session);
    if (marker.status !== "available") {
      bound.diagnostics.log("hook.marker-unreadable", { level: "warning", reason: marker.reason });
      return whenUnreadable;
    }
    return action(marker.marker);
  });
}
function postCompact(bound) {
  return withMarker(bound, SILENT, (marker) => {
    const recorded = recordGeneration(marker, bound.context.now().toISOString());
    bound.store.writeMarker(recorded.marker);
    bound.diagnostics.log("hook.generation-recorded", { generation: recorded.generation });
    return { delivery: "postcompact-recorded", stdout: "" };
  });
}
function decide(bound, marker) {
  return claimForPrompt(marker, bound.context.runIdentity, bound.context.now().toISOString());
}
function emitNotice(bound, decision) {
  const text = harnessJson("UserPromptSubmit", notice(bound.binding, decision.uncertain, decision.folded));
  bound.emit(text);
  bound.faults.afterOutput?.();
  bound.store.writeMarker(decision.marker);
  bound.diagnostics.log("hook.notice", { level: "warning", uncertain: [...decision.uncertain], folded: [...decision.folded] });
  return { delivery: "prompt-notice", stdout: text };
}
function deliverPanel(bound, decision, text) {
  bound.store.writeMarker(decision.marker);
  bound.faults.afterClaim?.();
  bound.emit(text);
  bound.faults.afterOutput?.();
  bound.store.writeMarker(recordDelivered(decision.marker, decision.claimed, bound.context.now().toISOString()));
  bound.diagnostics.log("hook.delivered", { generations: [...decision.claimed] });
  return { delivery: "prompt-panel", stdout: text };
}
async function userPromptSubmit(bound) {
  const inspected = await withMarker(bound, SILENT, (marker) => {
    const decision = decide(bound, marker);
    if (decision.kind === "silent")
      return { delivery: "prompt-silent", stdout: "" };
    if (decision.kind === "notice")
      return emitNotice(bound, decision);
    return "read-needed";
  });
  if (inspected !== "read-needed")
    return inspected;
  const text = await readPanelText(bound, "UserPromptSubmit");
  if (text === null)
    return SILENT;
  return withMarker(bound, SILENT, (marker) => {
    const decision = decide(bound, marker);
    if (decision.kind === "silent") {
      bound.diagnostics.log("hook.prompt-superseded");
      return { delivery: "prompt-silent", stdout: "" };
    }
    if (decision.kind === "notice")
      return emitNotice(bound, decision);
    return deliverPanel(bound, decision, text);
  });
}
async function runHook(stdin, context, diagnostics, emit, faults = {}) {
  const event = parseEvent(stdin);
  if (event === null || context.stateRoot.status !== "selected")
    return SILENT;
  const store = context.openStore(context.stateRoot.path);
  const read2 = store.readBinding(event.session, context.now().getTime());
  if (read2.status !== "available") {
    diagnostics.log("hook.binding-unavailable", { status: read2.status });
    return SILENT;
  }
  if (!cwdAdmitted(event.cwd, read2.binding)) {
    diagnostics.log("hook.cwd-refused", { level: "warning" });
    return SILENT;
  }
  const bound = { store, binding: read2.binding, event, context, diagnostics, faults, emit };
  try {
    switch (event.event) {
      case "SessionStart":
        return await sessionStart(bound);
      case "PreCompact":
        return await preCompact(bound);
      case "PostCompact":
        return await postCompact(bound);
      case "UserPromptSubmit":
        return await userPromptSubmit(bound);
    }
  } catch (error) {
    diagnostics.log("hook.failed", { level: "warning", kind: error instanceof RuntimeFailure ? error.kind : "unknown", failure: error });
    return SILENT;
  }
}

// packages/workflow-cli/src/commands/inspect.ts
import { lstatSync as lstatSync6 } from "fs";
var pass = (name, detail) => ({ name, status: "pass", detail, repair: null });
var fail = (name, detail, repair) => ({ name, status: "fail", detail, repair });
var skipped = (name, detail) => ({ name, status: "skipped", detail, repair: null });
function directoryCheck(name, path, repair) {
  try {
    const stat = lstatSync6(path);
    const uid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return fail(name, `${path} is not a real directory`, repair);
    if (stat.uid !== uid)
      return fail(name, `${path} is not owned by the effective user`, repair);
    if ((stat.mode & 511) !== 448)
      return fail(name, `${path} mode is not 0700`, repair);
    return pass(name, `${path} is a private 0700 directory`);
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT")
      return skipped(name, `${path} does not exist yet; it is created 0700 on first use`);
    return fail(name, `${path} is not accessible (${typeof code === "string" ? code : "lstat failed"})`, repair);
  }
}
async function storeChecks(context, request) {
  const executable = context.env.MSB_WORKFLOW_BD_EXECUTABLE ?? "";
  const beads = context.openBeads(executable, request.workspace, context.cwd);
  const read2 = await beads.verifyStore(isGitRepository(context.cwd));
  const knownSecretValues = beads.knownSecretValues();
  if (read2.status === "verified")
    return { checks: [pass("executable", `${read2.store.executable} (bd ${read2.store.version}; sha256 ${read2.store.executableDigest})`), pass("store", `${read2.store.storePath} (prefix ${read2.store.prefix}) agrees with where and config list`)], unavailable: null, knownSecretValues };
  if (read2.status === "executable-invalid")
    return { checks: [fail("executable", read2.reason, `Set MSB_WORKFLOW_BD_EXECUTABLE to the absolute path of the pinned bd ${PINNED_BD_VERSION} executable`), skipped("store", "not read because the executable failed")], unavailable: null, knownSecretValues };
  if (read2.status === "mismatch")
    return { checks: [pass("executable", executable), fail("store", read2.reason, `Select the workspace whose .beads store is the intended one and the pinned bd ${PINNED_BD_VERSION} at ${PINNED_BD_REVISION}`)], unavailable: null, knownSecretValues };
  return { checks: [pass("executable", executable), fail("store", read2.reason, "Check that the selected .beads store exists and no other bd process holds it, then retry")], unavailable: read2.reason, knownSecretValues };
}
function stateRootCheck(stateHome) {
  const check = directoryCheck("state-root", stateHome, "Configure MSB_WORKFLOW_STATE_HOME as an existing absolute directory you own");
  return check.status === "fail" && /mode is not 0700/.test(check.detail) ? pass("state-root", `${stateHome} exists and is owned by the effective user`) : check;
}
function bindingCheck(store, request, session, nowMilliseconds) {
  const binding = store.readBinding(session, nowMilliseconds);
  if (binding.status === "absent")
    return fail("binding", `no binding at ${store.bindingPath(session)}`, `Bind this session: msb-workflow bind --workspace ${request.workspace} --bead <bead-id> --session ${session}`);
  if (binding.status === "invalid")
    return fail("binding", `saved binding is not schema v3: ${binding.reason}`, `Move or delete ${store.bindingPath(session)} after reading it, then bind again`);
  if (binding.status !== "available")
    return fail("binding", binding.reason, "Repair the named private state entry (owner, mode 0600/0700, no symlink, one link)");
  if (binding.binding.workspace !== request.workspace)
    return fail("binding", `bound to workspace ${binding.binding.workspace}, not ${request.workspace}`, `Run commands with --workspace ${binding.binding.workspace}`);
  return pass("binding", `${binding.binding.beadId} in ${binding.binding.workspace}, observed ${binding.binding.observedAt} (${binding.stale ? "stale" : "fresh"})`);
}
function markerCheck(store, request, session) {
  const marker = store.readMarker(session);
  if (marker.status !== "available")
    return fail("marker", marker.reason, `Move or delete ${store.markerPath(session)} after reading it`);
  const summary = summarizeMarker(marker.marker);
  if (summary.uncertain.length > 0)
    return fail("marker", `generations ${summary.uncertain.join(", ")} were claimed but never recorded delivered`, `Run msb-workflow recover --workspace ${request.workspace} --session ${session}; the next prompt hook emits a notice, not a panel`);
  return pass("marker", `pending ${summary.pending.length}, delivered ${summary.delivered}, notified ${summary.notified}`);
}
function lockFilesCheck(store, request, session) {
  const lockFiles = store.checkLockFiles(request.workspace, session);
  const unsafe = lockFiles.filter((lock) => lock.status === "unsafe");
  if (unsafe.length > 0)
    return fail("lock-files", unsafe.map((lock) => `${lock.path}: ${lock.reason ?? "unsafe"}`).join("; "), "Remove the unsafe lock file; the helper recreates it 0600 on the next locked write");
  return pass("lock-files", lockFiles.map((lock) => `${lock.path}: ${lock.status}`).join("; "));
}
function bindingChecks(context, stateHome, request, session) {
  const addresses = stateAddresses(stateHome);
  const checks = [stateRootCheck(stateHome), directoryCheck("diagnostics-directory", addresses.diagnostics, "Repair the diagnostics directory to a private 0700 directory you own (a machine-mode run creates it 0700 when absent)")];
  if (session === null)
    return [...checks, skipped("binding", "no --session or CODEX_SESSION_ID supplied"), skipped("marker", "no session supplied"), skipped("lock-files", "no session supplied")];
  const store = context.openStore(stateHome);
  checks.push(bindingCheck(store, request, session, context.now().getTime()), markerCheck(store, request, session), lockFilesCheck(store, request, session));
  const sessions = directoryCheck("sessions-directory", addresses.sessions, "Repair the sessions directory to a private 0700 directory you own");
  if (sessions.status !== "skipped")
    checks.push(sessions);
  return checks;
}
async function runInspect(request, context, stateHome, diagnostics) {
  const resolution = resolveSession(request.session, context.env);
  if (resolution.status === "conflict" || resolution.status === "invalid")
    return { outcome: sessionOutcome(resolution), knownSecretValues: [] };
  const session = resolution.status === "resolved" ? resolution.session : null;
  const store = await storeChecks(context, request);
  const { knownSecretValues } = store;
  const checks = [...store.checks, ...bindingChecks(context, stateHome, request, session)];
  const failed = checks.filter((check) => check.status === "fail");
  diagnostics.log("inspect.completed", { failed: failed.map((check) => check.name) });
  const result = { workspace: request.workspace, session, stateRoot: stateHome, checks: checks.map((check) => ({ ...check })) };
  if (failed.length === 0)
    return { outcome: success("inspected", "every prerequisite passed", result, session === null ? `msb-workflow bind --workspace ${request.workspace} --bead <bead-id> --session <id>` : `msb-workflow recover --workspace ${request.workspace} --session ${session}`), knownSecretValues };
  const first = failed[0];
  if (store.unavailable !== null)
    return { outcome: { station: "beads-unavailable", message: store.unavailable, result: { station: "beads-unavailable", ...result }, repairAction: first.repair ?? "retry", nextAction: `msb-workflow inspect --workspace ${request.workspace}`, availablePaths: [], handoffPrerequisites: [] }, knownSecretValues };
  return { outcome: refusal("inspect-refused", `${failed.length} prerequisite(s) failed: ${failed.map((check) => check.name).join(", ")}`, first.repair ?? "Repair the first failed prerequisite", `msb-workflow inspect --workspace ${request.workspace}${session === null ? "" : ` --session ${session}`}`, result), knownSecretValues };
}

// packages/workflow-cli/src/cli.ts
var SILENT_DIAGNOSTICS = { log: () => {
  return;
}, setStation: () => {
  return;
}, flush: () => {
  return;
}, dispose: () => ({ file: null, written: 0, dropped: 0, refused: 0, failure: "open", closed: true }) };
var VALUE_OPTIONS = new Set(["--workspace", "--session", "--bead", "--evidence"]);
var COMMAND_WORDS = { inspect: "msb-workflow.inspect", bind: "msb-workflow.bind", recover: "msb-workflow.recover", hook: "msb-workflow.hook" };
function noteIssue(scan, issue) {
  scan.issue ??= issue;
}
function consumeValueOption(scan, token, value) {
  if (value === undefined || value.startsWith("--") || value.length === 0)
    noteIssue(scan, `${token} requires a value`);
  else if (scan.options.has(token))
    noteIssue(scan, `${token} was given more than once`);
  else
    scan.options.set(token, value);
}
function consumeWord(scan, token) {
  if (token.startsWith("-"))
    noteIssue(scan, `unknown option ${token}`);
  else if (scan.word === null && COMMAND_WORDS[token] !== undefined)
    scan.word = token;
  else
    noteIssue(scan, scan.word === null ? `unknown command ${token}` : `unexpected argument ${token}`);
}
function scanArgv(argv) {
  const scan = { word: null, issue: null, options: new Map, flags: new Set };
  const tokens = argv.filter((token) => token !== "--json");
  for (let index = 0;index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "--discover")
      scan.flags.add(token);
    else if (VALUE_OPTIONS.has(token)) {
      consumeValueOption(scan, token, tokens[index + 1]);
      index += 1;
    } else
      consumeWord(scan, token);
  }
  return scan;
}
function identityOf(scan) {
  if (scan.word !== null)
    return COMMAND_WORDS[scan.word];
  return scan.flags.has("--discover") ? "msb-workflow.discover" : "msb-workflow.help";
}
function optionIssue(scan, required, allowed) {
  for (const name of required)
    if (!scan.options.has(name))
      return `${scan.word} requires ${name}`;
  for (const name of scan.options.keys())
    if (!allowed.includes(name))
      return `${name} is not an option of ${scan.word}`;
  return null;
}
function buildCommand(scan, identity) {
  const usage = (message) => ({ kind: "usage", identity, message });
  const get = (name) => scan.options.get(name) ?? null;
  const word = scan.word;
  const workspace = get("--workspace");
  if (word === "bind") {
    const issue2 = optionIssue(scan, ["--workspace", "--bead"], ["--workspace", "--bead", "--session", "--evidence"]);
    if (issue2 !== null || workspace === null)
      return usage(issue2 ?? "bind requires --workspace");
    return { kind: "command", identity, request: { command: "bind", workspace, session: get("--session"), beadId: get("--bead"), evidence: get("--evidence") } };
  }
  const issue = optionIssue(scan, ["--workspace"], ["--workspace", "--session"]);
  if (issue !== null || workspace === null)
    return usage(issue ?? `${word} requires --workspace`);
  return { kind: "command", identity, request: { command: word === "inspect" ? "inspect" : "recover", workspace, session: get("--session") } };
}
function parseArgv(argv) {
  if (argv.length === 1 && argv[0] === "hook")
    return { kind: "hook" };
  const scan = scanArgv(argv);
  const identity = identityOf(scan);
  if (scan.issue !== null)
    return { kind: "usage", identity, message: scan.issue };
  if (scan.flags.has("--help"))
    return scan.word === null && scan.options.size === 0 && !scan.flags.has("--discover") ? { kind: "help" } : { kind: "usage", identity, message: "--help takes no other arguments" };
  if (scan.flags.has("--discover"))
    return scan.word === null && scan.options.size === 0 ? { kind: "discover" } : { kind: "usage", identity, message: "--discover takes no other arguments" };
  if (scan.word === null)
    return { kind: "usage", identity: "msb-workflow.help", message: scan.options.size === 0 ? `no command given; run ${HELP_ACTION}` : "a command word is required" };
  if (scan.word === "hook")
    return { kind: "usage", identity, message: "hook takes no arguments and reads the Harness event from stdin" };
  return buildCommand(scan, identity);
}
function factsFor(station, runIdentity, outcome) {
  const inspect3 = "msb-workflow inspect --workspace <absolute-path>";
  const prerequisites = outcome.handoffPrerequisites.length > 0 ? outcome.handoffPrerequisites : [inspect3];
  return {
    commandIdentity: station.commandIdentity,
    runIdentity,
    outcome: station.outcome,
    failureClass: station.failureClass,
    causeCode: station.causeCode,
    message: outcome.message,
    effectClass: station.effectClass,
    transactionState: station.transactionState,
    retryable: station.retryable,
    retryDelayMilliseconds: station.retryDelayMilliseconds,
    nextAction: station.guidance === "next-action" ? outcome.nextAction ?? inspect3 : null,
    availablePaths: outcome.availablePaths,
    repairAction: station.outcome === "success" ? null : outcome.repairAction ?? `Run ${HELP_ACTION}`,
    handoff: station.guidance === "handoff" ? { reason: outcome.message, prerequisites } : null,
    result: outcome.result
  };
}
function usageOutcome(message) {
  return { station: "usage-refused", message, result: { station: "usage-refused", usage: HELP_TEXT.split(`
`)[0] ?? "" }, repairAction: `Run ${HELP_ACTION} and repeat the command with the documented arguments`, handoffPrerequisites: [], nextAction: HELP_ACTION, availablePaths: ["msb-workflow.help", "msb-workflow.discover"] };
}
function helpOutcome() {
  return { station: "help-shown", message: "usage shown", result: { station: "help-shown", usage: HELP_TEXT.split(`
`)[0] ?? "", example: HELP_TEXT.split(`
`)[1] ?? "", discover: DISCOVER_ACTION }, repairAction: null, handoffPrerequisites: [], nextAction: null, availablePaths: ["msb-workflow.discover"] };
}
function discoverOutcome() {
  return { station: "discovery-shown", message: "contract discovery", result: { station: "discovery-shown", ...discovery() }, repairAction: null, handoffPrerequisites: [], nextAction: null, availablePaths: [] };
}
function capturingContext(context, readers) {
  return {
    ...context,
    openBeads: (executable, workspace, cwd) => {
      const reader = context.openBeads(executable, workspace, cwd);
      readers.push(reader);
      return reader;
    }
  };
}
async function runRouted(request, context, stateHome, diagnostics) {
  if (request.command === "bind")
    return runBind(request, context, stateHome, diagnostics);
  if (request.command === "recover")
    return runRecover(request, context, stateHome, diagnostics);
  return runInspect(request, context, stateHome, diagnostics);
}
async function dispatch(parsed, context, open) {
  if (parsed.kind === "help")
    return { outcome: helpOutcome(), identity: "msb-workflow.help", knownSecretValues: [] };
  if (parsed.kind === "discover")
    return { outcome: discoverOutcome(), identity: "msb-workflow.discover", knownSecretValues: [] };
  if (parsed.kind === "usage")
    return { outcome: usageOutcome(parsed.message), identity: parsed.identity, knownSecretValues: [] };
  if (parsed.kind === "hook")
    throw new Error("hook is routed before dispatch");
  if (context.stateRoot.status === "refused")
    return { outcome: stateRootOutcome(context.stateRoot.reason), identity: parsed.identity, knownSecretValues: [] };
  const workspace = canonicalWorkspace(parsed.request.workspace);
  if (workspace === null)
    return { outcome: workspaceOutcome(parsed.request.workspace), identity: parsed.identity, knownSecretValues: [] };
  const diagnostics = open(parsed.identity);
  diagnostics.log("command.started", { command: parsed.request.command });
  const { outcome, knownSecretValues } = await runRouted({ ...parsed.request, workspace }, context, context.stateRoot.path, diagnostics);
  return { outcome, identity: parsed.identity, knownSecretValues };
}
async function runHookCommand(context, io, options) {
  let diagnostics = SILENT_DIAGNOSTICS;
  try {
    const readers = [];
    const capturing = capturingContext(context, readers);
    if (context.stateRoot.status === "selected")
      diagnostics = context.openDiagnostics({ runIdentity: context.runIdentity, commandIdentity: "msb-workflow.hook", stateHome: context.stateRoot.path, sink: "file", knownSecretValues: () => readers.flatMap((reader) => reader.knownSecretValues()) });
    const stdin = await io.readStdin(HOOK_INPUT_LIMIT_BYTES + 1);
    const result = await runHook(stdin, capturing, diagnostics, io.stdout, options.hookFaults ?? {});
    diagnostics.log("hook.completed", { delivery: result.delivery });
  } catch {} finally {
    diagnostics.dispose();
  }
  return 0;
}
async function runCli(argv, context, io, options = {}) {
  const mode = machineMode(argv) ? "machine" : "human";
  const parsed = parseArgv(argv);
  if (parsed.kind === "hook")
    return runHookCommand(context, io, options);
  const readers = [];
  const capturing = capturingContext(context, readers);
  const holder = { current: null };
  const open = (identity) => {
    if (context.stateRoot.status !== "selected")
      return SILENT_DIAGNOSTICS;
    try {
      holder.current = context.openDiagnostics({ runIdentity: context.runIdentity, commandIdentity: identity, stateHome: context.stateRoot.path, sink: mode === "human" ? "stderr" : "file", writeStderr: io.stderr, knownSecretValues: () => readers.flatMap((reader) => reader.knownSecretValues()) });
    } catch {
      holder.current = SILENT_DIAGNOSTICS;
    }
    return holder.current;
  };
  let dispatched;
  try {
    dispatched = await dispatch(parsed, capturing, open);
  } catch {
    const identity = parsed.kind === "command" || parsed.kind === "usage" ? parsed.identity : "msb-workflow.help";
    dispatched = { outcome: internalFailure(), identity, knownSecretValues: readers.flatMap((reader) => reader.knownSecretValues()) };
  }
  const station = stationFor({ station: dispatched.outcome.station, commandIdentity: dispatched.identity });
  const facts = factsFor(station, context.runIdentity, dispatched.outcome);
  const rendered = mode === "human" && parsed.kind === "help" ? { stdout: HELP_TEXT, stderr: "", exit: 0 } : mode === "human" && parsed.kind === "discover" ? { stdout: renderDiscoveryHuman(), stderr: "", exit: 0 } : renderOutcome(facts, mode, { knownSecretValues: dispatched.knownSecretValues });
  try {
    const opened = holder.current;
    if (opened !== null) {
      opened.setStation(station.station);
      opened.log("command.completed", { stationId: station.station, outcome: facts.outcome, causeCode: facts.causeCode, transactionState: facts.transactionState, exit: rendered.exit });
      opened.dispose();
    }
  } catch {}
  if (rendered.stdout.length > 0)
    io.stdout(rendered.stdout);
  if (rendered.stderr.length > 0)
    io.stderr(rendered.stderr);
  return rendered.exit;
}
async function readAllStdin(limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > limit)
      break;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
var PROCESS_IO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin: readAllStdin
};
function main(context = productionContext(process.env, process.cwd()), options = {}) {
  const argv = process.argv.slice(2);
  runCli(argv, context, PROCESS_IO, options).then((code) => {
    process.exitCode = code;
  }, () => {
    if (argv.length === 1 && argv[0] === "hook") {
      process.exitCode = 0;
      return;
    }
    if (!machineMode(argv))
      process.stderr.write(`msb-workflow: INTERNAL_UNEXPECTED: internal failure; repair: run ${HELP_ACTION}
`);
    else
      process.stdout.write(`${JSON.stringify({ envelopeVersion: 1, contractVersion: "1.0.0", commandIdentity: "msb-workflow.help", runIdentity: "run-unknown", outcome: "failed", failureClass: "internal", causeCode: "INTERNAL_UNEXPECTED", message: "internal failure before dispatch", effectClass: "inspect", transactionState: "unknown", retryable: false, retryDelayMilliseconds: null, nextAction: HELP_ACTION, availablePaths: [], repairAction: `Run ${HELP_ACTION}`, handoff: null, result: null })}
`);
    process.exitCode = 1;
  });
}
if (import.meta.main)
  main();
export {
  main
};
