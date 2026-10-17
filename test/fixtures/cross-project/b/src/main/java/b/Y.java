package b;

import java.util.Set;
import java.util.HashSet;
import java.util.Optional;
import java.util.UUID;

public class Y {
      private final Set<OnlyInB> seen = new HashSet<>();

  public boolean see(OnlyInB item){
    return seen.add(item);
            }

    public Optional<OnlyInB> any() { return seen.stream().findFirst(); }
}
