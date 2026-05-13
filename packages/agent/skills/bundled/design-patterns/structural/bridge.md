# Bridge

## Intent

Split a large class or a set of closely related classes into two separate hierarchies — abstraction and implementation — which can be developed independently of each other.

## Problem

Say you have a geometric `Shape` class with a pair of subclasses: `Circle` and `Square`. You want to extend this hierarchy to incorporate colors, so you create `Red` and `Blue` shape subclasses. Since you already have two subclasses, you'd need to create four class combinations like `BlueCircle` and `RedSquare`.

Adding new shape types and colors grows the hierarchy exponentially. For example, adding a triangle would require introducing two new subclasses (one for each color), and adding a new color would require three new subclasses (one per shape type). The further along, the worse it gets.

## Solution

The problem occurs because we're trying to extend shape classes in two independent dimensions: by form and by color. That's a very common issue with class inheritance.

The Bridge pattern solves it by switching from inheritance to object composition. You extract one of the dimensions into a separate class hierarchy, so the original classes reference an object of the new hierarchy instead of having all of its state and behaviors within one class.

The **abstraction** (also called the interface) is a high-level control layer. It isn't meant to do real work on its own — it delegates to the **implementation** (also called the platform). In this case, the abstraction would be the shape, and the implementation would be the color. The shape can delegate color-related work to the linked color object.

## Structure

- **Abstraction** — provides high-level control logic. Relies on the implementation object to do the actual low-level work.
- **Implementation** — declares the interface that's common for all concrete implementations. The abstraction communicates with the implementation object only via methods declared here.
- **Concrete Implementations** — contain platform-specific code.
- **Refined Abstractions** — provide variants of control logic. Like their parent, they work with different implementations via the general implementation interface.
- The **Client** is only interested in working with the abstraction. However, it's the client's job to link the abstraction object with one of the implementation objects.

## Applicability

- Use Bridge when you want to divide and organize a monolithic class that has several variants of some functionality (e.g., a class that works with various database servers).
- Use Bridge when you need to extend a class in several orthogonal (independent) dimensions.
- Use Bridge if you need to switch implementations at runtime. Although it's optional, the Bridge pattern lets you replace the implementation object inside the abstraction — it's as easy as assigning a new value to a field.

## How to Implement

1. Identify the orthogonal dimensions in your classes. These could be: abstraction/platform, domain/infrastructure, front-end/back-end, or interface/implementation.
2. See what operations the client needs and define them in the base abstraction class.
3. Determine the operations available on all platforms. Declare the ones that the abstraction needs in the general implementation interface.
4. For all platforms in your domain, create concrete implementation classes that follow the implementation interface.
5. Inside the abstraction class, add a reference field for the implementation type. The abstraction delegates most of the work to the implementation object referenced in that field.
6. If you have several variants of high-level logic, create refined abstractions for each by extending the base abstraction class.
7. The client code should pass an implementation object to the abstraction's constructor to associate one with the other. After that, the client can forget about the implementation and work only with the abstraction object.

## Pros and Cons

**Pros:**

- You can create platform-independent classes and apps.
- The client code works with high-level abstractions and isn't exposed to platform details.
- *Open/Closed Principle.* You can introduce new abstractions and implementations independently.
- *Single Responsibility Principle.* You can focus on high-level logic in the abstraction and on platform details in the implementation.

**Cons:**

- You might make the code more complicated by applying the pattern to a highly cohesive class.

## Relations with Other Patterns

- **Bridge** is usually designed up-front, letting you develop parts of an application independently. **Adapter** is commonly used with existing apps to make otherwise-incompatible classes work together.
- **Bridge**, **State**, **Strategy** (and to some degree **Adapter**) have very similar structures. They all share the element of composition — delegating work to other objects. However, they all solve different problems.
- You can use **Abstract Factory** along with Bridge. This pairing is useful when some abstractions defined by Bridge can only work with specific implementations. Abstract Factory can encapsulate those relations and hide the complexity from client code.
- You can combine **Builder** with Bridge: the director class plays the role of the abstraction, while different builders act as implementations.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/bridge)*
