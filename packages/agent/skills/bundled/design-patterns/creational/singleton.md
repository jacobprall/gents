# Singleton

## Intent

Singleton is a creational design pattern that lets you ensure that a class has only one instance, while providing a global access point to this instance.

## Problem

The Singleton pattern solves two problems at the same time, violating the Single Responsibility Principle:

1. **Ensure that a class has just a single instance.** The most common reason is to control access to some shared resource — for example, a database or a file. You create an object, but later decide to create a new one. Instead of receiving a fresh object, you get the one you already created.

2. **Provide a global access point to that instance.** Like a global variable, the Singleton pattern lets you access some object from anywhere in the program. However, it also protects that instance from being overwritten by other code.

## Solution

All implementations of the Singleton have these two steps in common:

- Make the default constructor private, to prevent other objects from using the `new` operator with the Singleton class.
- Create a static creation method that acts as a constructor. Under the hood, this method calls the private constructor to create an object and saves it in a static field. All following calls to this method return the cached object.

## Structure

- **Singleton** class declares the static method `getInstance` that returns the same instance of its own class. The Singleton's constructor should be hidden from the client code. Calling the `getInstance` method should be the only way of getting the Singleton object.

## Applicability

- **A class in your program should have just a single instance available to all clients** — for example, a single database object shared by different parts of the program.
- **You need stricter control over global variables.** Unlike global variables, the Singleton pattern guarantees that there's just one instance of a class.

## How to Implement

1. Add a private static field to the class for storing the singleton instance.
2. Declare a public static creation method for getting the singleton instance.
3. Implement "lazy initialization" inside the static method. It should create a new object on its first call and put it into the static field. The method should always return that instance on all subsequent calls.
4. Make the constructor of the class private.
5. Go over the client code and replace all direct calls to the singleton's constructor with calls to its static creation method.

## Pros and Cons

**Pros:**
- You can be sure that a class has only a single instance.
- You gain a global access point to that instance.
- The singleton object is initialized only when it's requested for the first time.

**Cons:**
- Violates the Single Responsibility Principle (solves two problems at once).
- Can mask bad design, when components know too much about each other.
- Requires special treatment in a multithreaded environment.
- May be difficult to unit test since many test frameworks rely on inheritance when producing mock objects.

## Relations with Other Patterns

- A **Facade** class can often be transformed into a **Singleton** since a single facade object is sufficient in most cases.
- **Flyweight** would resemble **Singleton** if you managed to reduce all shared states to just one flyweight object. But there are two key differences: (1) there should be only one Singleton instance, whereas Flyweight can have multiple instances with different intrinsic states; (2) the Singleton object can be mutable, Flyweight objects are immutable.
- **Abstract Factories**, **Builders** and **Prototypes** can all be implemented as **Singletons**.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/singleton)*
