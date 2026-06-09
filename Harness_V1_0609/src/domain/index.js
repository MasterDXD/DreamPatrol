'use strict';

/**
 * DDD 领域驱动设计核心模块。
 * 提供完整的DDD战术模式工具集，包括实体、值对象、聚合根、领域事件、仓储、领域服务和规约模式。
 *
 * @module domain
 * @example
 * const { Entity, ValueObject, AggregateRoot, DomainEvent, DomainEventBus, Repository, InMemoryRepository, DomainService, Specification, ContextMapper } = require('./domain');
 */

const Entity = require('./entity');
const ValueObject = require('./value-object');
const AggregateRoot = require('./aggregate-root');
const { DomainEvent, DomainEventBus } = require('./domain-event');
const { Repository, InMemoryRepository } = require('./repository');
const DomainService = require('./domain-service');
const { Specification, AndSpecification, OrSpecification, NotSpecification } = require('./specification');
const ContextMapper = require('./context-mapper');

module.exports = {
  Entity,
  ValueObject,
  AggregateRoot,
  DomainEvent,
  DomainEventBus,
  Repository,
  InMemoryRepository,
  DomainService,
  Specification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  ContextMapper,
};
