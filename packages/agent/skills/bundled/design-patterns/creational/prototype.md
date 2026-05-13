# Prototype

Also known as: Clone

## Intent

Prototype is a creational design pattern that lets you copy existing objects without making your code dependent on their classes.

## Problem

Say you have an object, and you want to create an exact copy of it. You have to create a new object of the same class, then go through all fields of the original object and copy their values over to the new object.

But there's a catch: not all objects can be copied that way because some of the object's fields may be private and not visible from outside of the object itself. And since you have to know the object's class to create a duplicate, your code becomes dependent on that class. Sometimes you only know the interface that the object follows, but not its concrete class.

## Solution

The Prototype pattern delegates the cloning process to the actual objects that are being cloned. The pattern declares a common interface for all objects that support cloning. This interface lets you clone an object without coupling your code to the class of that object. Usually, such an interface contains just a single `clone` method.

The implementation of the `clone` method is very similar in all classes. The method creates an object of the current class and carries over all of the field values of the old object into the new one. You can even copy private fields because most programming languages let objects access private fields of other objects that belong to the same class.

An object that supports cloning is called a prototype. When your objects have dozens of fields and hundreds of possible configurations, cloning them might serve as an alternative to subclassing.

## Structure

- **Prototype interface** declares the cloning methods. In most cases, it's a single `clone` method.
- **Concrete Prototype** implements the cloning method. In addition to copying the original object's data to the clone, this method may also handle edge cases of the cloning process related to cloning linked objects, untangling recursive dependencies, etc.
- **Client** can produce a copy of any object that follows the prototype interface.
- **Prototype Registry** (optional) provides an easy way to access frequently-used prototypes. It stores a set of pre-built objects that are ready to be copied. The simplest registry is a `name → prototype` hash map.

## Applicability

- **Your code shouldn't depend on the concrete classes of objects you need to copy.** This happens a lot when your code works with objects passed from 3rd-party code via some interface.
- **You want to reduce the number of subclasses that only differ in the way they initialize their respective objects.** Use a set of pre-built prototypical objects configured in various ways instead.

## How to Implement

1. Create the prototype interface and declare the `clone` method in it. Or just add the method to all classes of an existing class hierarchy.
2. A prototype class must define the alternative constructor that accepts an object of that class as an argument. The constructor must copy the values of all fields defined in the class from the passed object into the newly created instance. If you're changing a subclass, you must call the parent constructor to let the superclass handle the cloning of its private fields.
3. The cloning method usually consists of just one line: running a `new` operator with the prototypical version of the constructor.
4. Optionally, create a centralized prototype registry to store a catalog of frequently used prototypes.

## Pros and Cons

**Pros:**
- Clone objects without coupling to their concrete classes.
- Get rid of repeated initialization code in favor of cloning pre-built prototypes.
- Produce complex objects more conveniently.
- Get an alternative to inheritance when dealing with configuration presets for complex objects.

**Cons:**
- Cloning complex objects that have circular references might be very tricky.

## Relations with Other Patterns

- Many designs start by using **Factory Method** and evolve toward **Abstract Factory**, **Prototype**, or **Builder**.
- **Abstract Factory** classes are often based on a set of **Factory Methods**, but you can also use **Prototype** to compose the methods on these classes.
- **Prototype** can help when you need to save copies of **Commands** into history.
- Designs that make heavy use of **Composite** and **Decorator** can often benefit from using **Prototype** — clone complex structures instead of re-constructing them from scratch.
- **Prototype** isn't based on inheritance, so it doesn't have its drawbacks. On the other hand, it requires a complicated initialization of the cloned object. **Factory Method** is based on inheritance but doesn't require an initialization step.
- Sometimes **Prototype** can be a simpler alternative to **Memento**.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/prototype)*
