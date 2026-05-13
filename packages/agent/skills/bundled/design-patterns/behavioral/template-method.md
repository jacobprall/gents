# Template Method

## Intent

Define the skeleton of an algorithm in the superclass but let subclasses override specific steps of the algorithm without changing its overall structure.

## Problem

Imagine you're creating a data mining application that analyzes corporate documents. Users feed the app documents in various formats (PDF, DOC, CSV), and it tries to extract meaningful data in a uniform format.

You notice that code for all three processing classes has a lot of duplication. While the code for dealing with various data formats is entirely different, the code for data processing and analysis is almost identical. The algorithm structure is the same across formats — only the details of reading/parsing differ.

There's another problem: client code that uses these classes has lots of conditionals picking the proper processing class. If all three classes shared a common interface or base class, the client could work with them polymorphically.

## Solution

The Template Method pattern suggests breaking an algorithm down into a series of steps, turning those steps into methods, and putting a series of calls to these methods inside a single *template method*. The steps may either be abstract or have some default implementation.

To use the algorithm, the client provides its own subclass, implements all abstract steps, and overrides some of the optional ones if needed (but not the template method itself).

There are three types of steps:
- **Abstract steps** — must be implemented by every subclass (the unique parts).
- **Optional steps (hooks)** — have an empty body or minimal default. Subclasses may override them for additional extension points before/after crucial steps.
- **Default steps** — contain a standard implementation that subclasses *may* override if needed.

**Real-world analogy:** A mass housing plan can be tweaked slightly — extending a deck, adding a garage, using different fixtures — but the fundamental structure remains the same.

## Structure

- **Abstract Class** — declares methods that act as steps of an algorithm, as well as the actual template method that calls these methods in a specific order. The steps may either be declared abstract or have some default implementation.
- **Concrete Classes** — can override all of the steps but not the template method itself.

## Applicability

- Use when you want to let clients extend only particular steps of an algorithm, but not the whole algorithm or its structure.
- Use when you have several classes that contain nearly identical algorithms with some minor differences. When the algorithm changes, you'd have to modify all classes.

## How to Implement

1. Analyze the target algorithm and determine whether you can break it into steps. Consider which steps are common to all subclasses and which will always be unique.
2. Create the abstract base class and declare the template method and a set of abstract methods representing the algorithm's steps. Outline the algorithm's structure in the template method by executing corresponding steps. Consider making the template method `final` to prevent subclasses from overriding it.
3. It's okay if all steps end up being abstract. However, some steps might benefit from a default implementation — subclasses don't have to implement those.
4. Think of adding hooks between the crucial steps of the algorithm.
5. For each variation of the algorithm, create a new concrete subclass. It must implement all of the abstract steps and may override some of the optional ones.

## Pros and Cons

**Pros:**
- You can let clients override only certain parts of a large algorithm, making them less affected by changes to other parts.
- You can pull the duplicate code into a superclass.

**Cons:**
- Some clients may be limited by the provided skeleton of an algorithm.
- You might violate the *Liskov Substitution Principle* by suppressing a default step implementation via a subclass.
- Template methods tend to be harder to maintain the more steps they have.

## Relations with Other Patterns

- **Factory Method** is a specialization of Template Method. A Factory Method can serve as a step in a large Template Method.
- **Template Method** is based on inheritance: it lets you alter parts of an algorithm by extending those parts in subclasses. **Strategy** is based on composition: you can alter parts of the object's behavior by supplying it with different strategies corresponding to that behavior. Template Method works at the class level, so it's static. Strategy works at the object level, letting you switch behaviors at runtime.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/template-method)*
