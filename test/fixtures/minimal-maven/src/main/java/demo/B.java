package demo;

import java.util.Set;
import org.apache.commons.lang3.StringUtils;
import java.util.TreeSet;
import java.util.Optional;

public class B {
    private final Set<String> names = new TreeSet<>();

  public boolean register(String name){
        String key = StringUtils.lowerCase(StringUtils.strip(name));
      return StringUtils.isNotEmpty(key) && names.add(key);
        }

public int count() { return names.size(); }
}
