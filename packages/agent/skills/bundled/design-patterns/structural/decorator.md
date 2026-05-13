# Decorator

**Also known as:** Wrapper

## Intent

Attach new behaviors to objects by placing these objects inside special wrapper objects that contain the new behaviors.

## Problem

You're working on a notification library. The initial version is based on the `Notifier` class that has only a few fields, a constructor, and a single `send` method. A client was supposed to create and configure the notifier once, then use it whenever something important happened.

At some point, users want more than just email notifications. Many want SMS, Facebook, or Slack messages. You start subclassing `Notifier` — `SMSNotifier`, `FacebookNotifier`, `SlackNotifier`. But then users want *combined* notifications (e.g., SMS + Facebook). You try to create subclasses for every combination, and the number of subclasses grows into a combinatorial explosion with each new notification type.

## Solution

When you need to alter an object's behavior, the first instinct is to extend a class. However, inheritance has serious caveats: it's static (you can't alter behavior of an existing object at runtime) and subclasses can only have one parent class (in most languages).

One of the alternatives is **composition**: an object holds a reference to another and delegates it some work, rather than inheriting. With composition, you can easily swap the referenced "helper" object at runtime.

A **decorator** (wrapper) is an object that can be linked with a target object. It contains the same set of methods as the target and delegates all requests to it. However, the decorator may alter the result by doing something before or after it passes the request to the target.

Since all decorators implement the same interface as the base component, the client doesn't care whether it works with a "pure" component or a decorated one. You can wrap the object in multiple decorators, stacking behaviors.

## Structure

- **Component** — declares the common interface for both wrappers and wrapped objects.
- **Concrete Component** — the class of objects being wrapped. It defines basic behavior, which can be altered by decorators.
- **Base Decorator** — has a field for referencing a wrapped object (declared with the component interface type). It delegates all operations to the wrapped object.
- **Concrete Decorators** — define extra behaviors that can be added to components dynamically. They override methods of the base decorator and execute their behavior before or after calling the parent method.

## Applicability

- Use the Decorator when you need to assign extra behaviors to objects at runtime without breaking the code that uses those objects.
- Use the Decorator when it's awkward or not possible to extend an object's behavior using inheritance. Many languages have the `final` keyword that prevents further extension of a class. For a final class, the only way to reuse existing behavior is to wrap the class with your own wrapper, using the Decorator pattern.

## How to Implement

1. Make sure your business domain can be represented as a primary component with multiple optional layers over it.
2. Figure out what methods are common to both the primary component and the optional layers. Create a component interface and declare those methods there.
3. Create a concrete component class and define the base behavior in it.
4. Create a base decorator class. It should have a field for storing a reference to a wrapped object. The field should be declared with the component interface type to allow linking to concrete components as well as decorators. The base decorator must delegate all work to the wrapped object.
5. Make sure all classes implement the component interface.
6. Create concrete decorators by extending them from the base decorator. A concrete decorator must execute its behavior before or after the call to the parent method (which always delegates to the wrapped object).
7. The client code must be responsible for creating decorators and composing them in the way the client needs.

## Pros and Cons

**Pros:**

- You can extend an object's behavior without making a new subclass.
- You can add or remove responsibilities from an object at runtime.
- You can combine several behaviors by wrapping an object into multiple decorators.
- *Single Responsibility Principle.* You can divide a monolithic class that implements many possible variants of behavior into several smaller classes.

**Cons:**

- It's hard to remove a specific wrapper from the wrappers stack.
- It's hard to implement a decorator in such a way that its behavior doesn't depend on the order in the decorators stack.
- The initial configuration code of layers might look ugly.

## Relations with Other Patterns

- **Adapter** provides a completely different interface to the wrapped object. **Proxy** provides it with the same interface. **Decorator** provides it with an enhanced interface.
- **Adapter** changes the interface of an existing object. **Decorator** enhances an object without changing its interface. Decorator supports recursive composition, which isn't possible when you use Adapter.
- **Composite** and **Decorator** have similar structure diagrams since both rely on recursive composition. A Decorator is like a Composite but only has one child. Decorator adds responsibilities to the wrapped object, while Composite just sums up children's results. They can cooperate too — you can use Decorator to extend the behavior of a specific object in the Composite tree.
- **Decorator** lets you change the skin of an object, while **Strategy** lets you change the guts. If a decorator changes the behavior of the object "from the outside," Strategy changes it "from the inside."
- **Decorator** and **Proxy** have similar structures but very different intents. Both are built on composition, but Proxy usually manages the lifecycle of its service object on its own, whereas the composition of Decorators is controlled by the client.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/decorator)*
