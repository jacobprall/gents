# Facade

## Intent

Provides a simplified interface to a library, a framework, or any other complex set of classes.

## Problem

Imagine your code must work with a broad set of objects that belong to a sophisticated library or framework. Ordinarily, you'd need to initialize all of those objects, keep track of dependencies, execute methods in the correct order, and so on.

As a result, the business logic of your classes becomes tightly coupled to the implementation details of third-party classes, making it hard to comprehend and maintain.

## Solution

A facade is a class that provides a simple interface to a complex subsystem containing lots of moving parts. A facade might provide limited functionality compared to working with the subsystem directly. However, it includes only those features that clients really care about.

Having a facade is handy when you need to integrate your app with a sophisticated library that has dozens of features, but you only need a tiny bit of its functionality.

### Real-World Analogy

When you call a shop to place a phone order, an operator is your facade to all services and departments of the shop. The operator provides a simple voice interface to the ordering system, payment gateway, and various delivery services.

## Structure

- **Facade** — provides convenient access to a particular part of the subsystem's functionality. It knows where to direct the client's request and how to operate all the moving parts.
- **Additional Facade** — can be created to prevent polluting a single facade with unrelated features that would make it yet another complex structure. Additional facades can be used by both clients and other facades.
- **Complex Subsystem** — consists of dozens of various objects. To make them all do something meaningful, you have to dive deep into the subsystem's implementation details. Subsystem classes aren't aware of the facade's existence — they operate within the system and work with each other directly.
- **Client** — uses the facade instead of calling the subsystem objects directly.

## Applicability

- Use the Facade when you need to have a limited but straightforward interface to a complex subsystem. Often, subsystems get more complex over time. Applying design patterns typically leads to creating more and smaller classes. A facade can provide a shortcut to the most-used features of the subsystem that fit most client requirements.
- Use the Facade when you want to structure a subsystem into layers. Create facades to define entry points to each level of a subsystem. You can reduce coupling between multiple subsystems by requiring them to communicate only through facades.

## How to Implement

1. Check whether it's possible to provide a simpler interface than what an existing subsystem already provides. You're on the right track if this interface makes the client code independent from many of the subsystem's classes.
2. Declare and implement this interface in a new facade class. The facade should redirect calls from the client code to appropriate objects of the subsystem. The facade should be responsible for initializing the subsystem and managing its further lifecycle (unless the client code already does this).
3. To get the full benefit from the pattern, make all the client code communicate with the subsystem only via the facade. Now the client code is protected from changes in the subsystem code. For example, when a subsystem gets upgraded to a new version, you'll only need to modify the code in the facade.
4. If the facade becomes too big, consider extracting part of its behavior to a new, refined facade class.

## Pros and Cons

**Pros:**

- You can isolate your code from the complexity of a subsystem.

**Cons:**

- A facade can become a "god object" coupled to all classes of an app.

## Relations with Other Patterns

- **Facade** defines a new interface for existing objects. **Adapter** tries to make the existing interface usable. Adapter usually wraps just one object, while Facade works with an entire subsystem of objects.
- **Abstract Factory** can serve as an alternative to Facade when you only want to hide the way subsystem objects are created from the client code.
- **Flyweight** shows how to make lots of little objects, whereas **Facade** shows how to make a single object that represents an entire subsystem.
- **Facade** and **Mediator** have similar jobs: they try to organize collaboration between lots of tightly coupled classes. Facade defines a simplified interface to a subsystem (doesn't add new functionality, subsystem is unaware of the facade). Mediator centralizes communication between components of the system (components are aware of and communicate through the mediator).
- A **Facade** class can often be transformed into a **Singleton** since a single facade object is sufficient in most cases.
- **Facade** is similar to **Proxy** in that both buffer a complex entity and initialize it on its own. Unlike Facade, Proxy has the same interface as its service object, making them interchangeable.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/facade)*
