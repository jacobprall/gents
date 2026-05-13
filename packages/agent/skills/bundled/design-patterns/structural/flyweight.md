# Flyweight

Also known as: Cache

## Intent

Flyweight is a structural design pattern that lets you fit more objects into the available amount of RAM by sharing common parts of state between multiple objects instead of keeping all of the data in each object.

## Problem

You're building a video game with a particle system — bullets, missiles, shrapnel. Each particle is a separate object with fields for color, sprite, coordinates, movement vector, and speed. The game crashes on lower-end machines because particles consume too much RAM. The color and sprite fields store nearly identical data across all particles but consume the most memory.

## Solution

The constant data of an object is called the **intrinsic state**. It lives within the object; other objects can only read it. The rest of the object's state, often altered from the outside, is called the **extrinsic state**.

The Flyweight pattern says: stop storing the extrinsic state inside the object. Instead, pass this state to specific methods which rely on it. Only the intrinsic state stays within the object, letting you reuse it in different contexts. You need fewer objects since they only differ in the intrinsic state, which has much fewer variations.

An object that only stores the intrinsic state is called a flyweight. Flyweights are immutable — their state is set once via the constructor. A **flyweight factory** manages a pool of existing flyweight objects, returning an existing one or creating a new one as needed.

## Structure

- **Flyweight** contains the portion of the original object's state that can be shared (intrinsic state). The same flyweight object can be used in many different contexts.
- **Context** contains the extrinsic state, unique across all original objects. When a context is paired with a flyweight, it represents the full state of the original object.
- **Client** calculates or stores the extrinsic state of flyweights.
- **Flyweight Factory** manages a pool of existing flyweights. Clients don't create flyweights directly — they call the factory, passing bits of the intrinsic state. The factory looks over previously created flyweights and either returns an existing one or creates a new one.

## Applicability

Use the Flyweight pattern **only** when your program must support a huge number of objects which barely fit into available RAM. The benefit depends on:

- An application needing to spawn a huge number of similar objects
- This draining all available RAM on a target device
- The objects containing duplicate states which can be extracted and shared

## How to Implement

1. Divide fields of the class into two parts: intrinsic state (unchanging data duplicated across many objects) and extrinsic state (contextual data unique to each object).
2. Leave the intrinsic state fields in the class, but make sure they're immutable. They should take their initial values only inside the constructor.
3. Go over methods that use extrinsic state fields. For each field used, introduce a new parameter and use it instead of the field.
4. Optionally, create a factory class to manage the pool of flyweights. It should check for an existing flyweight before creating a new one.
5. The client must store or calculate extrinsic state values to call methods of flyweight objects.

## Pros and Cons

**Pros:**
- You can save lots of RAM, assuming your program has tons of similar objects.

**Cons:**
- You might be trading RAM over CPU cycles when some context data needs to be recalculated each time.
- The code becomes much more complicated. New team members will wonder why the state was separated.

## Relations with Other Patterns

- You can implement shared leaf nodes of the **Composite** tree as **Flyweights** to save some RAM.
- **Flyweight** shows how to make lots of little objects, whereas **Facade** shows how to make a single object that represents an entire subsystem.
- **Flyweight** would resemble **Singleton** if you managed to reduce all shared states to just one flyweight object. But Singleton has one instance, Flyweight can have many with different intrinsic states; and Singleton can be mutable, Flyweight objects are immutable.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/flyweight)*
