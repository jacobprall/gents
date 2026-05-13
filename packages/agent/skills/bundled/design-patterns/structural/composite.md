# Composite

**Also known as:** Object Tree

## Intent

Compose objects into tree structures and then work with these structures as if they were individual objects.

## Problem

Imagine an ordering system that deals with `Products` and `Boxes`. A `Box` can contain several `Products` as well as smaller `Boxes`. These little `Boxes` can also hold some `Products` or even smaller `Boxes`, and so on.

Say you want to calculate the total price of an order. You could try the direct approach — unwrap all the boxes, go through every product, and calculate the total. But that would require knowing the exact classes and nesting depth of all components in advance, and the nesting levels would make the traversal awkward or even impossible in real code.

## Solution

The Composite pattern suggests that you work with `Products` and `Boxes` through a common interface that declares a method for calculating the total price.

For a product, it simply returns the product's price. For a box, it goes over each item in the box, asks for its price, and then returns the total. If one of the items is a smaller box, that box also iterates over its contents and so on, until the prices of all inner components are calculated. A box could even add extra cost to the final price, such as packaging cost.

The benefit is that you don't need to care about the concrete classes of objects composing the tree. You can treat them all the same via the common interface. When you call a method, the objects themselves pass the request down the tree.

## Structure

- **Component** — the interface that describes operations common to both simple and complex elements of the tree.
- **Leaf** — a basic element of the tree that doesn't have sub-elements. Leaves do most of the real work since they don't have anyone to delegate the work to.
- **Container (Composite)** — an element that has sub-elements: leaves or other containers. A container doesn't know the concrete classes of its children — it works with all sub-elements only via the component interface. Upon receiving a request, a container delegates the work to its sub-elements, processes intermediate results, and returns the final result to the client.
- **Client** — works with all elements through the component interface. As a result, the client can work in the same way with both simple and complex elements of the tree.

## Applicability

- Use the Composite pattern when you have to implement a tree-like object structure.
- Use the pattern when you want the client code to treat both simple and complex elements uniformly. All elements defined by the Composite pattern share a common interface. Using that interface, the client doesn't have to worry about the concrete class of the objects it works with.

## How to Implement

1. Make sure the core model of your app can be represented as a tree structure. Try to break it down into simple elements and containers. Remember that containers must be able to contain both simple elements and other containers.
2. Declare the component interface with a list of methods that make sense for both simple and complex components.
3. Create a leaf class to represent simple elements. A program may have multiple different leaf classes.
4. Create a container class to represent complex elements. Provide it with an array field for storing references to sub-elements. The array must be able to store both leaves and containers, so make sure it's declared with the component interface type. While implementing the methods of the component interface, remember that a container is supposed to delegate most of the work to sub-elements.
5. Define the methods for adding and removing child elements in the container.

## Pros and Cons

**Pros:**

- You can work with complex tree structures more conveniently: use polymorphism and recursion to your advantage.
- *Open/Closed Principle.* You can introduce new element types into the app without breaking existing code.

**Cons:**

- It might be difficult to provide a common interface for classes whose functionality differs too much. In certain scenarios, you'd need to overgeneralize the component interface, making it harder to comprehend.

## Relations with Other Patterns

- You can use **Builder** when creating complex Composite trees because you can program its construction steps to work recursively.
- **Chain of Responsibility** is often used in conjunction with Composite. A leaf component gets a request, passes it through the chain of all parent components down to the root of the object tree.
- You can use **Iterators** to traverse Composite trees.
- You can use **Visitor** to execute an operation over an entire Composite tree.
- You can implement shared leaf nodes of the Composite tree as **Flyweights** to save RAM.
- **Composite** and **Decorator** have similar structure diagrams since both rely on recursive composition. A Decorator is like a Composite but has only one child component. Decorator adds additional responsibilities to the wrapped object, while Composite just "sums up" its children's results. However, they can cooperate: you can use Decorator to extend the behavior of a specific object in the Composite tree.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/composite)*
