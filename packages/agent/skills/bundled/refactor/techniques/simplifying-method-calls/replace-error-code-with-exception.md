# Replace Error Code with Exception

## Problem

A method returns a special value that indicates an error.

## Solution

Throw an exception instead.

### Before

```java
int withdraw(int amount) {
  if (amount > _balance) {
    return -1;
  }
  else {
    balance -= amount;
    return 0;
  }
}
```

### After

```java
void withdraw(int amount) throws BalanceException {
  if (amount > _balance) {
    throw new BalanceException();
  }
  balance -= amount;
}
```

## Why Refactor

Returning error codes is an obsolete holdover from procedural programming. In modern programming, error handling is performed by special classes, which are named exceptions. If a problem occurs, you "throw" an error, which is then "caught" by one of the exception handlers. Special error-handling code, which is ignored in normal conditions, is activated to respond.

## Benefits

- Frees code from a large number of conditionals for checking various error codes. Exception handlers are a much more succinct way to differentiate normal execution paths from abnormal ones.

- Exception classes can implement their own methods, thus containing part of the error handling functionality (such as for sending error messages).

- Unlike exceptions, error codes can't be used in a constructor, since a constructor must return only a new object.

## Drawbacks

- An exception handler can turn into a goto-like crutch. Avoid this! Don't use exceptions to manage code execution. Exceptions should be thrown only to inform of an error or critical situation.

## How to Refactor

1. Try to perform these refactoring steps for only one error code at a time. This will make it easier to keep all the important information in your head and avoid errors.

2. Find all calls to a method that returns error codes and, instead of checking for an error code, wrap it in `try`/`catch` blocks.

3. Inside the method, instead of returning an error code, throw an exception.

4. Change the method signature so that it contains information about the exception being thrown (`@throws` section).
