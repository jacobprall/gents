# Adapter

**Also known as:** Wrapper

## Intent

Allows objects with incompatible interfaces to collaborate.

## Problem

Imagine you're building a stock market monitoring app. The app downloads stock data from multiple sources in XML format, then displays charts and diagrams. At some point you decide to integrate a smart third-party analytics library — but it only works with data in JSON format.

You could change the library to work with XML, but that might break existing code that depends on it. And you might not even have access to the library's source code.

## Solution

Create an **adapter** — a special object that converts the interface of one object so that another object can understand it. The adapter wraps one of the objects to hide the complexity of conversion happening behind the scenes. The wrapped object isn't even aware of the adapter.

There are two flavors:

- **Object adapter** — uses composition. The adapter holds a reference to the service object, implements the client interface, and translates calls by delegating to the wrapped service.
- **Class adapter** — uses multiple inheritance (where supported). The adapter inherits interfaces from both the client and the service, so no wrapping is necessary.

## Structure

- **Client** — contains existing business logic.
- **Client Interface** — describes the protocol that other classes must follow to collaborate with the client code.
- **Service** — a useful class (often third-party or legacy) with an incompatible interface.
- **Adapter** — implements the client interface while wrapping the service object. Receives calls from the client via the client interface and translates them into calls to the wrapped service in a format it can understand.

## Applicability

- Use the Adapter when you want to use an existing class but its interface isn't compatible with the rest of your code.
- Use the Adapter when you want to reuse several existing subclasses that lack some common functionality that can't be added to the superclass. You could extend each subclass and put the missing functionality into new child classes — but you'd have to duplicate code across all of them. The adapter lets you put the missing functionality into a single wrapper class.

## How to Implement

1. Identify at least two classes with incompatible interfaces (a useful service and one or more clients).
2. Declare the client interface and describe how clients communicate with the service.
3. Create the adapter class that follows the client interface. Leave all methods empty for now.
4. Add a field to the adapter class to store a reference to the service object. Initialize it via the constructor.
5. Implement all methods of the client interface in the adapter class. The adapter should delegate most of the real work to the service object.
6. Clients should use the adapter via the client interface. This lets you change or extend adapters without affecting client code.

## Pros and Cons

**Pros:**

- *Single Responsibility Principle.* You can separate the interface conversion code from the primary business logic.
- *Open/Closed Principle.* You can introduce new adapters without breaking existing client code, as long as they work through the client interface.

**Cons:**

- Overall complexity increases because you need to introduce a set of new interfaces and classes. Sometimes it's simpler to just change the service class to match the rest of your code.

## Relations with Other Patterns

- **Bridge** is usually designed up-front, letting you develop parts of an application independently. **Adapter** is commonly used with existing apps to make incompatible classes work together.
- **Adapter** provides a completely different interface for accessing an existing object. **Decorator** enhances an object without changing its interface. **Proxy** provides the same interface and adds lazy initialization or access control.
- **Facade** defines a new interface for existing objects. **Adapter** tries to make an existing interface usable — it usually wraps just one object, while Facade works with an entire subsystem.
- **Adapter** changes the interface of an existing object. **Decorator** enhances an object without changing its interface. Decorator also supports recursive composition, which isn't possible with Adapter.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/adapter)*
