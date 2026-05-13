# Visitor

## Intent

Visitor is a behavioral design pattern that lets you separate algorithms from the objects on which they operate.

## Problem

Your team develops an app which works with geographic information structured as a colossal graph. Each node type is represented by its own class. You need to implement exporting the graph into XML format, but the system architect won't allow altering existing node classes — the code is in production and changes risk introducing bugs. Besides, XML export code doesn't belong in node classes whose primary job is geodata.

## Solution

The Visitor pattern suggests that you place the new behavior into a separate class called **visitor**, instead of trying to integrate it into existing classes. The original object that had to perform the behavior is now passed to one of the visitor's methods as an argument, providing the method access to all necessary data.

The pattern uses a technique called **Double Dispatch**: instead of letting the client select the proper method to call, objects themselves "accept" a visitor and tell it what visiting method should be executed.

```
// Elements accept a visitor and redirect to the correct method
node.accept(visitor)  →  visitor.visitCity(this)
```

This way, adding new behaviors only requires implementing a new visitor class. The element classes need only one small change — an `accept` method — and then never need to change again.

## Structure

- **Visitor interface** declares a set of visiting methods that can take concrete elements as arguments. These methods may have the same names if the language supports overloading, but the parameter types must be different.
- **Concrete Visitors** implement several versions of the same behaviors, tailored for different concrete element classes.
- **Element interface** declares a method for "accepting" visitors. This method should have one parameter declared with the type of the visitor interface.
- **Concrete Elements** must implement the acceptance method. The purpose is to redirect the call to the proper visitor's method corresponding to the current element class.
- **Client** usually represents a collection or some other complex object (e.g. a Composite tree). Clients typically aren't aware of all the concrete element classes because they work with objects from the collection via some abstract interface.

## Applicability

- **You need to perform an operation on all elements of a complex object structure** (e.g. an object tree) and the elements have different classes.
- **You want to clean up the business logic of auxiliary behaviors.** Extract all non-primary behaviors into visitor classes so the main classes stay focused.
- **A behavior makes sense only in some classes of a class hierarchy, but not in others.** Extract this behavior into a visitor and implement only the relevant visiting methods, leaving the rest empty.

## How to Implement

1. Declare the visitor interface with a set of "visiting" methods, one per each concrete element class.
2. Declare the element interface. If working with an existing hierarchy, add the abstract `accept` method to the base class.
3. Implement the acceptance methods in all concrete element classes. These must simply redirect the call to a visiting method on the incoming visitor that matches the class of the current element.
4. The element classes should only work with visitors via the visitor interface.
5. For each behavior that can't be implemented inside the element hierarchy, create a new concrete visitor class and implement all visiting methods.
6. The client must create visitor objects and pass them into elements via "acceptance" methods.

## Pros and Cons

**Pros:**
- Open/Closed Principle: introduce new behavior that works with objects of different classes without changing those classes.
- Single Responsibility Principle: move multiple versions of the same behavior into the same class.
- A visitor object can accumulate useful information while working with various objects. Handy when traversing a complex object structure like a tree.

**Cons:**
- You need to update all visitors each time a class gets added to or removed from the element hierarchy.
- Visitors might lack the necessary access to the private fields and methods of the elements.

## Relations with Other Patterns

- You can treat **Visitor** as a powerful version of the **Command** pattern. Its objects can execute operations over various objects of different classes.
- You can use **Visitor** to execute an operation over an entire **Composite** tree.
- You can use **Visitor** along with **Iterator** to traverse a complex data structure and execute some operation over its elements, even if they all have different classes.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/visitor)*
