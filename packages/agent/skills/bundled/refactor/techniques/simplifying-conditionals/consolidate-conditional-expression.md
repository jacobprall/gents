# Consolidate Conditional Expression

## Problem

You have multiple conditionals that lead to the same result or action.

## Solution

Consolidate all these conditionals in a single expression.

### Before

```java
double disabilityAmount() {
  if (seniority < 2) {
    return 0;
  }
  if (monthsDisabled > 12) {
    return 0;
  }
  if (isPartTime) {
    return 0;
  }
  // Compute the disability amount.
  // ...
}
```

### After

```java
double disabilityAmount() {
  if (isNotEligibleForDisability()) {
    return 0;
  }
  // Compute the disability amount.
  // ...
}
```

## Why Refactor

Your code contains many alternating operators that perform identical actions. It isn't clear why the operators are split up.

The main purpose of consolidation is to extract the conditional to a separate method for greater clarity.

## Benefits

- Eliminates duplicate control flow code. Combining multiple conditionals that have the same "destination" helps to show that you're doing only one complicated check leading to one action.
- By consolidating all operators, you can now isolate this complex expression in a new method with a name that explains the conditional's purpose.

## How to Refactor

1. Before refactoring, make sure that the conditionals don't have any "side effects" or otherwise modify something, instead of simply returning values. Side effects may be hiding in the code executed inside the operator itself, such as when something is added to a variable based on the results of a conditional.
2. Consolidate the conditionals in a single expression by using `and` and `or`. As a general rule when consolidating:
   - Nested conditionals are joined using `and`.
   - Consecutive conditionals are joined with `or`.
3. Perform [Extract Method](/extract-method) on the operator conditions and give the method a name that reflects the expression's purpose.
