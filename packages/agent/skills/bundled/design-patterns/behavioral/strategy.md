# Strategy

## Intent

Define a family of algorithms, put each into a separate class, and make their objects interchangeable.

## Problem

One day you decided to create a navigation app for casual travelers. The app is centered around a beautiful map that helps users quickly orient themselves in any city. The most requested feature was automatic route planning — a user should be able to enter an address and see the fastest route on the map.

The first version only built routes over roads. Then you added pathfinding for walking, then public transport routing, then cycling. Each new algorithm bloated the main class, making it harder to maintain. A change to one algorithm affected others. Teamwork became difficult because merge conflicts arose constantly in the same massive file.

## Solution

The Strategy pattern suggests extracting all algorithms that do the same thing in different ways into separate classes called *strategies*.

The original class, called *context*, stores a reference to one of the strategies and delegates the work to a linked strategy object. The context isn't responsible for selecting an appropriate algorithm — instead, the client passes the desired strategy to the context. The context works with all strategies through a generic interface that only exposes a single method for triggering the algorithm encapsulated within the selected strategy.

This way the context becomes independent of concrete strategies, so you can add new algorithms or modify existing ones without changing the context or other strategies.

**Real-world analogy:** Various strategies for getting to the airport — bus, cab, bicycle. You pick the strategy depending on factors like budget or time constraints.

## Structure

- **Context** — maintains a reference to one of the concrete strategies and communicates with this object only via the strategy interface.
- **Strategy** (interface) — common to all concrete strategies. It declares a method the context uses to execute a strategy.
- **Concrete Strategies** — implement different variations of an algorithm the context uses.
- **Client** — creates a specific strategy object and passes it to the context. The context exposes a setter that lets clients replace the strategy associated with the context at runtime.

## Applicability

- Use when you want to use different variants of an algorithm within an object and be able to switch from one algorithm to another during runtime.
- Use when you have a lot of similar classes that only differ in the way they execute some behavior.
- Use to isolate the business logic of a class from the implementation details of algorithms that may not be as important in the context of that logic.
- Use when your class has a massive conditional operator that switches between different variants of the same algorithm.

## How to Implement

1. In the context class, identify an algorithm that's prone to frequent changes (or a massive conditional that selects and executes a variant at runtime).
2. Declare the strategy interface common to all variants of the algorithm.
3. One by one, extract all algorithms into their own classes. They should all implement the strategy interface.
4. In the context class, add a field for storing a reference to a strategy object. Provide a setter for replacing values of that field. The context should work with the strategy object only through the strategy interface.
5. Clients of the context must associate it with a suitable strategy that matches the way they expect the context to perform its primary job.

## Pros and Cons

**Pros:**
- You can swap algorithms used inside an object at runtime.
- You can isolate the implementation details of an algorithm from the code that uses it.
- You can replace inheritance with composition.
- *Open/Closed Principle* — you can introduce new strategies without having to change the context.

**Cons:**
- If you only have a couple of algorithms that rarely change, there's no real reason to overcomplicate the program with new classes and interfaces.
- Clients must be aware of the differences between strategies to be able to select a proper one.
- Many modern programming languages have functional type support that lets you implement different versions of an algorithm inside a set of anonymous functions — achieving the same goal with less bloat.

## Relations with Other Patterns

- **Bridge, State, Strategy (and to some degree Adapter)** have very similar structures based on composition — delegating work to other objects — but each solves a different problem.
- **State** can be considered an extension of Strategy. Both are based on composition, but Strategy makes strategy objects completely independent, while State allows dependencies between concrete states.
- **Command and Strategy** may look similar because both parameterize an object with some action. However, Command describes *any* operation as an object (can queue, delay, log, undo), while Strategy usually describes different ways to do the *same thing*.
- **Decorator** lets you change the skin of an object; Strategy lets you change the guts.
- **Template Method** uses inheritance: it lets you alter parts of an algorithm by extending those parts in subclasses. Strategy uses composition: you can alter parts of the object's behavior by supplying it with different strategies. Template Method works at the class level. Strategy works at the object level.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/strategy)*
