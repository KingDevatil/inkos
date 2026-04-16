import { Users } from "lucide-react";
import { SidebarCard } from "./SidebarCard";

interface Character {
  readonly name: string;
  readonly role?: string;
  readonly description?: string;
}

interface CharacterSectionProps {
  readonly characters?: Character[];
}

export function CharacterSection({ characters = [] }: CharacterSectionProps) {
  return (
    <SidebarCard title="角色矩阵" defaultOpen={true}>
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {characters.length === 0 ? (
          <div className="text-sm text-muted-foreground py-2">暂无角色信息</div>
        ) : (
          characters.map((character, index) => (
            <div key={index} className="flex items-start gap-2 p-2 rounded-lg bg-accent/50">
              <Users className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{character.name}</div>
                {character.role && (
                  <div className="text-xs text-muted-foreground">{character.role}</div>
                )}
                {character.description && (
                  <div className="text-xs text-muted-foreground/80 mt-1 line-clamp-2">
                    {character.description}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </SidebarCard>
  );
}
