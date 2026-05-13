# Mediator

**Also known as:** Intermediary, Controller

## Intent

Reduce chaotic dependencies between objects. Restrict direct communications between objects and force them to collaborate only via a mediator object.

## Problem

Consider a dialog for editing customer profiles. It contains various form controls — text fields, checkboxes, buttons — that interact with each other. A checkbox might reveal a hidden input field; a "submit" button must validate every field before saving; a text field might reset another field's state.

If elements communicate directly, each control becomes tightly coupled to many others. You can't reuse a single control in a different dialog because it drags its dependencies along. Modifying one control can cascade changes throughout the entire form.

## Solution

Cease all direct communication between components. Instead, make them collaborate indirectly by calling a special **mediator** object that redirects calls to appropriate components. Components depend only on the mediator interface, not on dozens of siblings.

**Real-world analogy:** Aircraft pilots don't speak to each other directly when deciding who lands next. All communication goes through the air traffic controller, who coordinates traffic without needing to control each plane directly.

The mediator encapsulates complex interaction logic in one place, making individual components simpler, more reusable, and easier to modify independently.

## Structure

- **Components** — various classes containing business logic. Each component holds a reference to the mediator (declared via the mediator interface). The component doesn't know the actual mediator class, so it can be reused with a different mediator.
- **Mediator interface** — declares methods of communication with components (typically just a notification method accepting a sender and optional event context).
- **Concrete Mediators** — encapsulate the relations between various components. Concrete mediators often keep references to all managed components and sometimes manage their lifecycle.

## Applicability

- When you can't reuse a component in a different program because it's too dependent on other components.
- When you find yourself creating tons of component subclasses just to reuse basic behavior in various contexts.
- When changing one tightly coupled class requires editing dozens of other classes.

## How to Implement

1. Identify a group of tightly coupled classes that would benefit from being more independent (e.g., for easier maintenance or simpler reuse).
2. Declare the mediator interface. Usually a single notification method is sufficient. Optionally include context information (sender reference, event type) in that method's parameters.
3. Implement the concrete mediator class. Store references to all components inside the mediator.
4. Make components store a reference to the mediator object. The connection is usually established in the component's constructor.
5. Change components' code so that they call the mediator's notification method instead of methods on other components. Extract code that involves other components into the mediator.

## Pros and Cons

**Pros:**
- *Single Responsibility Principle* — extract communication between components into a single place, making it easier to comprehend and maintain.
- *Open/Closed Principle* — introduce new mediators without changing the actual components.
- Reduce coupling between components.
- Reuse individual components more easily.

**Cons:**
- Over time a mediator can evolve into a God Object — overly complex and doing too much.

## Relations with Other Patterns

- **Chain of Responsibility** — passes a request along a dynamic chain until one handler processes it. Mediator eliminates direct dependencies entirely by centralizing communication.
- **Command** — establishes unidirectional connections between senders and receivers. Mediator eliminates direct connections, making communication bidirectional and implicit.
- **Observer** — dynamically allows objects to subscribe/unsubscribe from events. Mediator objects often implement Observer internally—components become publishers and the mediator is the subscriber.
- **Facade** — both abstract work of subsystem classes. Facade defines a simplified interface but doesn't add new functionality; subsystem objects are unaware of the facade. Mediator centralizes communication; components explicitly know about and use the mediator.

---

*Source: [refactoring.guru](https://refactoring.guru/design-patterns/mediator)*
