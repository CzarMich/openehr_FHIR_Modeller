<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Prompts;

use Mcp\Capability\Attribute\McpPrompt;
use Mcp\Schema\Content\PromptMessage;

#[McpPrompt(name: 'guide_explorer')]
readonly final class GuideExplorer extends AbstractPrompt
{
    /**
     * Guided workflow to discover, search, and retrieve openEHR implementation guides using guide_search, guide_get, and guide_adl_idiom_lookup tools.
     *
     *
     * @return PromptMessage[]
     */
    public function __invoke(): array
    {
        return $this->loadPromptMessages('guide_explorer');
    }
}
