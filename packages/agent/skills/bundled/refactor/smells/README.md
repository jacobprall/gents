# Code Smells

Code smells are indicators of problems that can be addressed during refactoring. Code smells are easy to spot and fix, but they may be just symptoms of a deeper problem with code.

## Categories

### Bloaters
Code, methods and classes that have increased to such gargantuan proportions that they are hard to work with. Usually these smells accumulate over time as the program evolves.

→ See [bloaters/](bloaters/)

### Object-Orientation Abusers
Incomplete or incorrect application of object-oriented programming principles.

→ See [oo-abusers/](oo-abusers/)

### Change Preventers
If you need to change something in one place in your code, you have to make many changes in other places too. Program development becomes much more complicated and expensive as a result.

→ See [change-preventers/](change-preventers/)

### Dispensables
Something pointless and unneeded whose absence would make the code cleaner, more efficient and easier to understand.

→ See [dispensables/](dispensables/)

### Couplers
Smells that contribute to excessive coupling between classes or show what happens if coupling is replaced by excessive delegation.

→ See [couplers/](couplers/)
