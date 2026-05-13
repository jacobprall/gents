# Observer

**Also known as:** Event-Subscriber, Listener

## Intent

Define a subscription mechanism to notify multiple objects about any events that happen to the object they're observing.

## Problem

Imagine you have two types of objects: a Customer and a Store. The customer is very interested in a particular product that should become available soon.

The customer could visit the store every day to check availability — but most of these trips would be pointless while the product is still en route. Alternatively, the store could send tons of emails (spam) to all customers each time a new product becomes available — saving some customers the wasted trips but upsetting others who aren't interested.

You have a conflict: either the customer wastes resources polling, or the store wastes resources broadcasting to everyone.

## Solution

The object that has some interesting state is called the *publisher*. Other objects that want to track changes to the publisher's state are called *subscribers*.

The Observer pattern suggests adding a subscription mechanism to the publisher class so individual objects can subscribe to or unsubscribe from a stream of events coming from that publisher:

1. An array field for storing a list of references to subscriber objects.
2. Several public methods that allow adding subscribers to and removing them from that list.

When an important event happens to the publisher, it goes over its subscribers and calls a specific notification method on their objects. All subscribers must implement the same interface, and the publisher communicates with them only via that interface. This interface should declare the notification method along with a set of parameters the publisher can use to pass contextual data.

**Real-world analogy:** If you subscribe to a newspaper or magazine, you no longer need to go to the store to check if the next issue is available. Instead, the publisher sends new issues directly to your mailbox right after publication (or even in advance).

## Structure

- **Publisher** — issues events of interest to other objects. Contains subscription infrastructure (subscriber list, subscribe/unsubscribe methods) and a notification method that iterates over the subscriber list and calls their update method.
- **Subscriber** (interface) — declares the notification interface. In most cases, it consists of a single `update` method. The method may have parameters that let the publisher pass event details along with the update.
- **Concrete Subscribers** — perform actions in response to notifications issued by the publisher. Each class implements the subscriber interface so the publisher isn't coupled to concrete classes.
- **Client** — creates publisher and subscriber objects separately and registers subscribers with publishers.

## Applicability

- Use when changes to the state of one object may require changing other objects, and the actual set of objects is unknown beforehand or changes dynamically.
- Use when some objects in your app must observe others, but only for a limited time or in specific cases.

## How to Implement

1. Break your business logic into two parts: the core functionality (independent of other code) becomes the publisher; the rest becomes subscriber classes.
2. Declare the subscriber interface with at least one `update` method.
3. Declare the publisher interface with methods for adding/removing a subscriber from the list.
4. Decide where to put the actual subscription list and the implementation of subscription methods (usually an abstract class with default behavior).
5. Create concrete subscriber classes. Each must implement the subscriber interface and handle the notification appropriately.
6. The client must create all necessary subscribers and register them with proper publishers.

## Pros and Cons

**Pros:**
- *Open/Closed Principle* — you can introduce new subscriber classes without having to change the publisher's code (and vice versa if there's a publisher interface).
- You can establish relations between objects at runtime.

**Cons:**
- Subscribers are notified in random order.

## Relations with Other Patterns

- **Chain of Responsibility, Command, Mediator, and Observer** are various ways of connecting senders and receivers of requests.
- **Mediator** — the difference between Mediator and Observer is often elusive. The primary goal of Mediator is to eliminate mutual dependencies among components. With Observer, some objects act as subordinates of others.
- **Command** — you can use Command to turn any operation into an object. Command's parameters become fields. This conversion lets you use deferred execution, queue operations, store command history, and send commands to remote services.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/observer)*
