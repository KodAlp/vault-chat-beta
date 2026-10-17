---
title: Bayes' theorem
domain: istatistik
level: undergraduate
source_file: sample/bayes-theorem.md
converted_by: sample-vault
---

# Bayes' theorem

## Statement

Bayes' theorem tells us how to update the probability of a hypothesis $A$ after observing evidence $B$:

$$P(A \mid B) = \frac{P(B \mid A)\, P(A)}{P(B)}$$

Here $P(A)$ is the **prior**, $P(B \mid A)$ is the **likelihood**, and $P(A \mid B)$ is the **posterior**. The denominator is found with the law of total probability:

$$P(B) = P(B \mid A)\, P(A) + P(B \mid \neg A)\, P(\neg A)$$

## Intuition

The prior says how plausible the hypothesis was before seeing anything. The likelihood says how well the hypothesis explains the evidence. Dividing by $P(B)$ rescales the result so the posterior is a proper probability. When the prior is very small, even strong evidence may leave the posterior small.

## Worked example: a medical test

A disease affects 1% of a population. A test detects it in 99% of sick people (sensitivity), and gives a false positive in 5% of healthy people. A random person tests positive. What is the probability that they are actually sick?

Let $D$ be "has the disease" and $+$ be "tests positive". We know $P(D) = 0.01$, $P(+ \mid D) = 0.99$ and $P(+ \mid \neg D) = 0.05$.

1. Probability of a positive test:

$$P(+) = 0.99 \cdot 0.01 + 0.05 \cdot 0.99 = 0.0099 + 0.0495 = 0.0594$$

2. Posterior:

$$P(D \mid +) = \frac{0.99 \cdot 0.01}{0.0594} = \frac{0.0099}{0.0594} = \frac{1}{6} \approx 0.167$$

So only about 16.7% of people who test positive are actually sick, even though the test is 99% sensitive. Most positives come from the large healthy group, because 5% of 99% of the population is much more than 99% of 1%.

## Common mistakes

- Confusing $P(A \mid B)$ with $P(B \mid A)$ (the confusion of the inverse).
- Ignoring the prior $P(A)$, known as the base rate fallacy: it is why the 99% sensitive test above still gives a posterior of only 1/6.
- Forgetting the false positive rate when computing $P(B)$.
- Treating a posterior as final: it becomes the prior for the next piece of evidence.
