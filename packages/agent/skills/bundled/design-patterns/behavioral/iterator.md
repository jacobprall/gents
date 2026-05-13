# Iterator

## Intent

Traverse elements of a collection without exposing its underlying representation (list, stack, tree, graph, etc.).

## Problem

Collections are among the most common data structures, but they come in many shapes — lists, stacks, trees, graphs, and more exotic structures. Each structure requires its own traversal algorithm. Adding multiple traversal methods (DFS, BFS, random access, filtered iteration) directly to collection classes bloats them with navigation code unrelated to their primary purpose of storing data. Client code becomes coupled to specific collection implementations.

## Solution

Extract the traversal behavior into a separate object called an **iterator**. The iterator encapsulates all traversal details — current position, how many elements remain, how to advance — and exposes them through a simple common interface (typically `next` and `hasMore`).

Multiple iterator objects can traverse the same collection simultaneously and independently. Each iterator maintains its own traversal state. The collection itself provides a factory method that returns the appropriate iterator type, keeping the specific iterator class hidden from clients.

## Structure

- **Iterator interface** — declares operations required for traversing a collection: fetching the next element, retrieving the current position, restarting iteration, etc.
- **Concrete Iterators** — implement specific traversal algorithms. Each iterator instance tracks its own traversal state independently.
- **Collection interface (Iterable)** — declares one or more methods for getting iterators compatible with the collection.
- **Concrete Collections** — return new instances of a particular concrete iterator class each time the client requests one. The rest of the collection's code goes in the same class.
- **Client** — works with collections and iterators via their interfaces, remaining decoupled from concrete classes.

## Applicability

- When your collection has a complex underlying data structure and you want to hide its complexity from clients (both for convenience and protection).
- When you want to reduce duplication of traversal code across your application.
- When you want your code to be able to traverse different data structures or when the structure types are unknown beforehand.

## How to Implement

1. Declare the iterator interface. At minimum it needs a method for fetching the next element. For convenience, add methods for fetching the previous element, tracking current position, and checking whether iteration has finished.
2. Declare the collection interface with a method for fetching iterators.
3. Implement concrete iterator classes for the collections you want to traverse. An iterator object must be linked to a single collection instance (usually via the constructor).
4. Implement the collection interface in your collection classes. The main idea is to provide a shortcut for creating iterators tailored to a specific collection class.
5. Replace all collection traversal code in the client with the use of iterators. The client fetches an iterator each time it needs to iterate over elements.

## Pros and Cons

**Pros:**
- *Single Responsibility Principle* — bulky traversal algorithms are extracted into separate classes.
- *Open/Closed Principle* — new collection types and new iterators can be introduced without breaking anything.
- Each iterator object contains its own state, so you can iterate over the same collection in parallel.
- For the same reason, you can delay or pause an iteration and continue it when needed.

**Cons:**
- Applying the pattern can be overkill if your app only works with simple collections.
- For some specialized collections, using an iterator may be less efficient than going through elements directly.

## Relations with Other Patterns

- **Composite** — you can use iterators to traverse composite trees.
- **Factory Method** — useful in conjunction with Iterator to let collection subclasses return different types of iterators.
- **Memento** — can be used alongside Iterator to capture the current iteration state and roll back if needed.
- **Visitor** — combine with Iterator to traverse a complex data structure and execute an operation on each element, even if they differ in class.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/iterator)*
