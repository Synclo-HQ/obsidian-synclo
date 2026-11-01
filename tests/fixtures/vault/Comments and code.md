# Comments and code

Visible text %%with a private aside%% stays.
The quarter went well. %% The board doesn't know about the delay yet. %%

%%
A whole private paragraph.
With several lines.
%%

Text before <!-- an HTML comment --> text after.
<!--
A multi-line HTML comment.
-->
Start of line %% a comment that
runs over two lines %% and the rest of the line stays.

```js
// %% this is code, not a comment %%
const tag = "#not-a-tag";
```

Inline code `%%kept%%` and `#kept` stays as written.

```dataview
TABLE status FROM #project
```

```dataviewjs
dv.list(dv.pages().file.name)
```

```tasks
not done
due before tomorrow
```

```query
tag:#meeting
```

```base
views:
  - type: table
```

This note is called `= this.file.name` and has `$= dv.pages().length` pages.

> [!note] Inside a callout
> A line in the callout.
> %% a comment in the callout %%
> ```dataview
> LIST FROM "Projects"
> ```
> The callout goes on.

~~~
A tilde fence with ``` inside
~~~

The end.
