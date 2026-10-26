"""Mistral SDK adapter (lazy import).

Implements the agentic ToolModelClient with the mistralai SDK: chat turns
with function calling. Imported lazily so the rest of the worker —
contracts, guard, agent loop — stays testable without the SDK installed.
The SDK surface used here follows the mistralai Python client as documented
in October 2026; verify against the current SDK when deploying.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .repairer import ModelTurn, ToolCall


class MistralModelClient:
    def __init__(self, model_name: str = "devstral-latest", api_key_env: str = "MISTRAL_API_KEY"):
        from mistralai import Mistral  # imported lazily: provider dependency

        api_key = os.environ.get(api_key_env)
        if not api_key:
            raise RuntimeError(f"{api_key_env} is not set; the worker cannot call the model")
        self.client = Mistral(api_key=api_key)
        self.model_name = model_name

    def turn(
        self,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> ModelTurn:
        response = self.client.chat.complete(
            model=self.model_name,
            messages=[{"role": "system", "content": system}, *messages],
            tools=tools,
        )
        message = response.choices[0].message
        content = message.content
        if isinstance(content, list):
            content = "".join(part.text for part in content)
        calls: list[ToolCall] = []
        for call in message.tool_calls or []:
            arguments = call.function.arguments or "{}"
            calls.append(
                ToolCall(
                    id=call.id,
                    name=call.function.name,
                    arguments=json.loads(arguments) if isinstance(arguments, str) else dict(arguments),
                )
            )
        return ModelTurn(content=content, tool_calls=calls)
