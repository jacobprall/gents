# Proxy

## Intent

Proxy is a structural design pattern that lets you provide a substitute or placeholder for another object. A proxy controls access to the original object, allowing you to perform something either before or after the request gets through to the original object.

## Problem

You have a massive object that consumes a vast amount of system resources. You need it from time to time, but not always. You could implement lazy initialization, but all of the object's clients would need to execute deferred initialization code, causing duplication. And the class may be part of a closed 3rd-party library, making direct modification impossible.

## Solution

The Proxy pattern suggests that you create a new proxy class with the same interface as the original service object. Then you update your app so that it passes the proxy object to all of the original object's clients. Upon receiving a request from a client, the proxy creates a real service object and delegates all the work to it.

Since the proxy implements the same interface as the original class, it can be passed to any client that expects a real service object.

### Common Proxy Types

- **Virtual proxy (lazy initialization):** Create the heavyweight object only when it's actually needed.
- **Protection proxy (access control):** Only let specific clients use the service object based on credentials.
- **Remote proxy:** Handle network communication for a service object on a remote server.
- **Logging proxy:** Keep a history of requests to the service object.
- **Caching proxy:** Cache results of client requests and manage the cache lifecycle.
- **Smart reference:** Dismiss a heavyweight object once there are no clients using it.

## Structure

- **Service Interface** declares the interface of the Service. The proxy must follow this interface to disguise itself as a service object.
- **Service** is a class that provides some useful business logic.
- **Proxy** has a reference field that points to a service object. After the proxy finishes its processing (lazy init, logging, access control, caching, etc.), it passes the request to the service object. Usually, proxies manage the full lifecycle of their service objects.
- **Client** should work with both services and proxies via the same interface.

## Applicability

- **Lazy initialization (virtual proxy):** When you have a heavyweight service object that wastes resources by being always up.
- **Access control (protection proxy):** When you want only specific clients to use the service object.
- **Local execution of a remote service (remote proxy):** When the service object is on a remote server.
- **Logging requests (logging proxy):** When you want to keep a history of requests.
- **Caching request results (caching proxy):** When you need to cache results of recurring requests.
- **Smart reference:** When you need to dismiss a heavyweight object once no clients reference it.

## How to Implement

1. If there's no pre-existing service interface, create one to make proxy and service objects interchangeable.
2. Create the proxy class. It should have a field for storing a reference to the service.
3. Implement the proxy methods according to their purposes. In most cases, after doing some work, the proxy should delegate to the service object.
4. Consider introducing a creation method that decides whether the client gets a proxy or a real service.
5. Consider implementing lazy initialization for the service object.

## Pros and Cons

**Pros:**
- Control the service object without clients knowing about it.
- Manage the lifecycle of the service object when clients don't care about it.
- The proxy works even if the service object isn't ready or is not available.
- Open/Closed Principle: introduce new proxies without changing the service or clients.

**Cons:**
- The code may become more complicated since you need to introduce new classes.
- The response from the service might get delayed.

## Relations with Other Patterns

- With **Adapter** you access an existing object via a different interface. With **Proxy**, the interface stays the same. With **Decorator** you access the object via an enhanced interface.
- **Facade** is similar to **Proxy** in that both buffer a complex entity and initialize it on its own. Unlike Facade, Proxy has the same interface as its service object, which makes them interchangeable.
- **Decorator** and **Proxy** have similar structures, but very different intents. Both are built on composition, but a Proxy usually manages the life cycle of its service object on its own, whereas the composition of Decorators is always controlled by the client.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/proxy)*
