<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Prompts;

use Mcp\Capability\Attribute\McpPrompt;
use Mcp\Schema\Content\PromptMessage;

#[McpPrompt(name: 'terminology_explorer')]
readonly final class TerminologyExplorer extends AbstractPrompt
{
    /**
     * Guided workflow to discover, search, resolve and retrieve openEHR Terminology codes, rubrics, groups, and codesets.
     *
     *
     * @return PromptMessage[]
     */
    public function __invoke(): array
    {
        return $this->loadPromptMessages('terminology_explorer');
    }
}
