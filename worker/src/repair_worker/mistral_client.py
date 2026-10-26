"""Mistral SDK adapter (lazy import).

Implements ModelClient with the mistralai SDK. Imported lazily so the rest
of the worker — contracts, guard, loop — stays testable without the SDK
installed. The SDK surface used here follows the mistralai Python client as
documented in October 2026; verify against the current SDK when deploying.
"""

from __future__ import annotations

import os


class MistralModelClient:
    def __init__(self, model_name: str = "codestral-latest", api_key_env: str = "MISTRAL_API_KEY"):
        from mistralai import Mistral  # imported lazily: provider dependency

        api_key = os.environ.get(api_key_env)
        if not api_key:
            raise RuntimeError(f"{api_key_env} is not set; the worker cannot call the model")
        self.client = Mistral(api_key=api_key)
        self.model_name = model_name

    def complete(self, system: str, user: str) -> str:
        response = self.client.chat.complete(
            model=self.model_name,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        content = response.choices[0].message.content
        if isinstance(content, list):
            content = "".join(part.text for part in content)
        return content
