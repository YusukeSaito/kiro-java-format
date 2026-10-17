package m;

import java.util.List;
import java.util.Collections;
import java.util.ArrayList;
import java.io.File;

public class M {
  private final List<String> lines = new ArrayList<>();

        public void add(String line){
    lines.add(line);
  }

public List<String> all() { return Collections.unmodifiableList(lines); }
}
